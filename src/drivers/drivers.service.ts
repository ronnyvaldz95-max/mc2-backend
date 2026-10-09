// =============================================================
// Servicio de matching pasajero <-> conductor + gestión de estado
// online/offline y posición en vivo de los conductores.
// =============================================================
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { pool, redis, DRIVERS_GEO_KEY } from '../db';

const EARTH_AVG_SPEED_KMH = 25; // velocidad promedio urbana estimada, ajustar según la ciudad

// Cada cuánto sincronizamos la posición a Postgres (respaldo/persistencia),
// para no machacar la base de datos con un write por cada ping de 3-5s.
// El camino caliente del matching SIEMPRE lee de Redis, nunca de esto.
const POSTGRES_SYNC_INTERVAL_MS = 30_000;

// Si un conductor debe esta comisión o más (en guaraníes), no puede
// ponerse online ni recibir viajes hasta que lo marques pagado en el
// panel. Se cambia con la variable de entorno COMMISSION_DEBT_LIMIT.
export const COMMISSION_DEBT_LIMIT = Number(process.env.COMMISSION_DEBT_LIMIT) || 30_000;

export interface NearbyDriver {
  driver_id: string;
  full_name: string;
  rating: number;
  vehicle_type: string | null;
  plate: string | null;
  distance_m: number;
  eta_min: number;
  lat: number;
  lon: number;
}

function estimateEtaMinutes(distanceMeters: number): number {
  const km = distanceMeters / 1000;
  return Math.max(1, Math.round((km / EARTH_AVG_SPEED_KMH) * 60));
}

@Injectable()
export class DriversService implements OnModuleInit {
  private readonly logger = new Logger(DriversService.name);
  // driverId -> timestamp del último write a Postgres (en memoria, por proceso)
  private readonly lastPostgresSync = new Map<string, number>();

  // Al arrancar el servidor (por ejemplo, después de que Render lo
  // duerma o lo redespliegue) ningún conductor tiene un socket abierto
  // todavía: los que figuraban 'online' son fantasmas. Los pasamos a
  // offline y vaciamos el índice de Redis; cada app vuelve a mandar
  // driver:online al reconectarse.
  async onModuleInit() {
    try {
      const r = await pool.query(`UPDATE driver_profiles SET status = 'offline' WHERE status = 'online'`);
      await redis.del(DRIVERS_GEO_KEY);
      this.logger.log(`Arranque: ${r.rowCount} conductor(es) fantasma pasados a offline`);
    } catch (err: any) {
      this.logger.error(`No se pudo limpiar conductores online al arrancar: ${err.message}`);
    }
  }

  /** Comisión que el conductor todavía no pagó (Gs.). */
  async getCommissionDebt(driverId: string): Promise<number> {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(commission_amount), 0)::int AS owed
       FROM trips WHERE driver_id = $1 AND status = 'completed' AND commission_paid_at IS NULL`,
      [driverId],
    );
    return rows[0].owed;
  }

  async findNearbyDrivers(
    lat: number,
    lon: number,
    radiusMeters = 3000,
    maxResults = 5,
  ): Promise<NearbyDriver[]> {
    // Paso 1: Redis GEOSEARCH -- rápido, en memoria, es el camino caliente.
    // Nota: Redis espera (lon, lat), al revés de como lo decimos en español.
    const raw = (await redis.geosearch(
      DRIVERS_GEO_KEY,
      'FROMLONLAT',
      lon,
      lat,
      'BYRADIUS',
      radiusMeters,
      'm',
      'ASC',
      'COUNT',
      maxResults * 3, // pedimos de más por si algunos ya no están 'online' en Postgres
      'WITHCOORD',
      'WITHDIST',
    )) as unknown as [string, string, [string, string]][];

    if (raw.length === 0) return [];

    // raw viene como [ [driverId, distanceStr, [lon, lat]], ... ]
    const byId = new Map(
      raw.map(([driverId, distStr, coords]) => [
        driverId,
        {
          distance_m: parseFloat(distStr),
          lon: parseFloat(coords[0]),
          lat: parseFloat(coords[1]),
        },
      ]),
    );

    // Paso 2: confirmar en Postgres que siguen 'online' y traer sus datos.
    const ids = [...byId.keys()];
    const { rows } = await pool.query(
      `SELECT u.id, u.full_name, u.rating, v.vehicle_type, v.plate
       FROM users u
       JOIN driver_profiles dp ON dp.user_id = u.id
       LEFT JOIN vehicles v ON v.id = dp.active_vehicle_id
       WHERE u.id = ANY($1::uuid[]) AND dp.status = 'online'
         AND dp.approval_status = 'approved' AND u.is_active = TRUE
         AND (SELECT COALESCE(SUM(t.commission_amount), 0) FROM trips t
              WHERE t.driver_id = u.id AND t.status = 'completed'
                AND t.commission_paid_at IS NULL) < $2`,
      [ids, COMMISSION_DEBT_LIMIT],
    );

    // Paso 3: combinar, ordenar por distancia real, cortar a maxResults.
    return rows
      .map((r) => {
        const geo = byId.get(r.id)!;
        return {
          driver_id: r.id,
          full_name: r.full_name,
          rating: Number(r.rating),
          vehicle_type: r.vehicle_type,
          plate: r.plate,
          distance_m: Math.round(geo.distance_m),
          eta_min: estimateEtaMinutes(geo.distance_m),
          lat: geo.lat,
          lon: geo.lon,
        };
      })
      .sort((a, b) => a.distance_m - b.distance_m)
      .slice(0, maxResults);
  }

  /**
   * Estado de aprobación del conductor ('pending' | 'approved' |
   * 'suspended' | 'rejected'), o null si no existe / la cuenta fue
   * eliminada. Solo 'approved' puede ponerse online.
   */
  async getApprovalStatus(driverId: string): Promise<string | null> {
    const { rows } = await pool.query(
      `SELECT dp.approval_status
       FROM driver_profiles dp JOIN users u ON u.id = dp.user_id
       WHERE dp.user_id = $1 AND u.is_active = TRUE`,
      [driverId],
    );
    return rows[0]?.approval_status ?? null;
  }

  // --- Ciclo de vida online/offline + posición en vivo ---------------

  /**
   * Un conductor se conecta y pasa a estar disponible para recibir viajes.
   * Marca status='online' en Postgres (fuente de verdad del estado) y deja
   * su posición inicial en el índice geoespacial de Redis.
   */
  async setDriverOnline(driverId: string, lat: number, lon: number): Promise<void> {
    await pool.query(`UPDATE driver_profiles SET status = 'online', updated_at = now() WHERE user_id = $1`, [
      driverId,
    ]);
    await this.updateDriverLocation(driverId, lat, lon, { forcePostgresSync: true });
    this.logger.log(`Conductor ${driverId} -> online`);
  }

  /**
   * Un conductor se desconecta (cierra la app, pierde señal, etc).
   * Lo sacamos del índice de Redis (para que no lo sigan matcheando) y
   * marcamos offline en Postgres.
   */
  async setDriverOffline(driverId: string): Promise<void> {
    await redis.zrem(DRIVERS_GEO_KEY, driverId);
    await pool.query(`UPDATE driver_profiles SET status = 'offline', updated_at = now() WHERE user_id = $1`, [
      driverId,
    ]);
    this.lastPostgresSync.delete(driverId);
    this.logger.log(`Conductor ${driverId} -> offline`);
  }

  /**
   * Ping de posición (se espera cada 3-5s mientras el conductor está online).
   * Camino caliente: SIEMPRE actualiza Redis (GEOADD), que es lo que lee
   * findNearbyDrivers(). Postgres se sincroniza solo cada POSTGRES_SYNC_INTERVAL_MS,
   * como respaldo/persistencia, no como parte del camino de matching.
   */
  async updateDriverLocation(
    driverId: string,
    lat: number,
    lon: number,
    opts: { forcePostgresSync?: boolean } = {},
  ): Promise<void> {
    await redis.geoadd(DRIVERS_GEO_KEY, lon, lat, driverId);

    const now = Date.now();
    const last = this.lastPostgresSync.get(driverId) ?? 0;
    if (opts.forcePostgresSync || now - last >= POSTGRES_SYNC_INTERVAL_MS) {
      await pool.query(
        `UPDATE driver_profiles
         SET last_location = ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
             last_location_at = now()
         WHERE user_id = $1`,
        [driverId, lon, lat],
      );
      this.lastPostgresSync.set(driverId, now);
    }
  }
}
