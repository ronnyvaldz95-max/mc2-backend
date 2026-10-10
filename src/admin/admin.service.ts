// =============================================================
// Lógica del panel de administración: aprobar/suspender
// conductores, ver y cancelar viajes, y llevar la cuenta de las
// comisiones (Gs. 3.000 por viaje completado, cobradas en efectivo
// o transferencia y marcadas a mano como pagadas).
// =============================================================
import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { pool } from '../db';
import { COMMISSION_DEBT_LIMIT, DriversService } from '../drivers/drivers.service';
import { DriversGateway } from '../drivers/drivers.gateway';
import { TripsGateway } from '../trips/trips.gateway';

export const APPROVAL_STATUSES = ['pending', 'approved', 'suspended', 'rejected'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

// Estados de un viaje que todavía no terminó.
const ACTIVE_TRIP_STATUSES = ['requested', 'matched', 'accepted', 'arrived', 'in_progress'];

// Un viaje que no avanza en este tiempo se considera abandonado y se
// cancela solo (como hacen Uber/Bolt), para que no quede "en curso"
// para siempre ni bloquee al conductor.
const STALE_TRIP_SQL = `
  (status = 'requested' AND requested_at < now() - interval '30 minutes')
  OR (status IN ('matched', 'accepted', 'arrived') AND COALESCE(matched_at, requested_at) < now() - interval '3 hours')
  OR (status = 'in_progress' AND COALESCE(started_at, matched_at, requested_at) < now() - interval '6 hours')
`;
const STALE_CHECK_EVERY_MS = 10 * 60_000;

@Injectable()
export class AdminService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdminService.name);
  private staleTimer?: NodeJS.Timeout;

  onModuleInit() {
    void this.cancelStaleTrips();
    this.staleTimer = setInterval(() => void this.cancelStaleTrips(), STALE_CHECK_EVERY_MS);
  }

  onModuleDestroy() {
    if (this.staleTimer) clearInterval(this.staleTimer);
  }

  async cancelStaleTrips(): Promise<number> {
    try {
      const { rows } = await pool.query(
        `UPDATE trips SET status = 'cancelled_by_admin', cancelled_at = now()
         WHERE ${STALE_TRIP_SQL}
         RETURNING id, driver_id`,
      );
      for (const t of rows) {
        const payload = { trip_id: t.id, cancelled_by: 'admin', reason: 'stale' };
        this.tripsGateway.notifyTrip(t.id, 'trip:cancelled', payload);
        if (t.driver_id) {
          this.driversGateway.setActiveTrip(t.driver_id, null);
          this.driversGateway.notifyDriver(t.driver_id, 'trip:cancelled', payload);
        }
      }
      if (rows.length) this.logger.log(`${rows.length} viaje(s) abandonados cancelados automáticamente`);
      return rows.length;
    } catch (err: any) {
      this.logger.error(`No se pudieron cancelar viajes abandonados: ${err.message}`);
      return 0;
    }
  }

  constructor(
    private readonly driversService: DriversService,
    private readonly driversGateway: DriversGateway,
    private readonly tripsGateway: TripsGateway,
  ) {}

  async getStats() {
    const { rows } = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM trips WHERE requested_at >= date_trunc('day', now() AT TIME ZONE 'America/Asuncion') AT TIME ZONE 'America/Asuncion')::int AS trips_today,
         (SELECT COUNT(*) FROM trips WHERE status = 'completed' AND completed_at >= date_trunc('day', now() AT TIME ZONE 'America/Asuncion') AT TIME ZONE 'America/Asuncion')::int AS completed_today,
         (SELECT COALESCE(SUM(commission_amount), 0) FROM trips WHERE status = 'completed' AND completed_at >= date_trunc('day', now() AT TIME ZONE 'America/Asuncion') AT TIME ZONE 'America/Asuncion')::int AS commission_today,
         (SELECT COUNT(*) FROM trips WHERE status = ANY($1::text[]))::int AS active_trips,
         (SELECT COUNT(*) FROM trips WHERE status = 'no_drivers_available' AND requested_at >= now() - interval '1 hour')::int AS unmatched_last_hour,
         (SELECT COUNT(*) FROM driver_profiles WHERE status = 'online')::int AS drivers_online,
         (SELECT COUNT(*) FROM driver_profiles WHERE approval_status = 'pending')::int AS drivers_pending,
         (SELECT COALESCE(SUM(commission_amount), 0) FROM trips WHERE status = 'completed' AND commission_paid_at IS NULL)::int AS commission_owed`,
      [ACTIVE_TRIP_STATUSES],
    );
    return { ...rows[0], debt_limit: COMMISSION_DEBT_LIMIT };
  }

  async listDrivers(status?: ApprovalStatus) {
    const { rows } = await pool.query(
      `SELECT
         u.id, u.full_name, u.phone, u.rating, u.is_active, u.created_at,
         dp.license_number, dp.approval_status, dp.approval_notes, dp.approved_at,
         dp.status AS online_status, dp.last_location_at,
         v.plate, v.brand, v.model, v.color, v.vehicle_type,
         (SELECT COUNT(*) FROM trips t WHERE t.driver_id = u.id AND t.status = 'completed')::int AS completed_trips
       FROM users u
       JOIN driver_profiles dp ON dp.user_id = u.id
       LEFT JOIN vehicles v ON v.id = dp.active_vehicle_id
       WHERE ($1::text IS NULL OR dp.approval_status = $1)
       ORDER BY (dp.approval_status = 'pending') DESC, u.created_at DESC`,
      [status ?? null],
    );
    return rows;
  }

  async setDriverStatus(driverId: string, status: ApprovalStatus, notes: string | null) {
    const { rows } = await pool.query(
      `UPDATE driver_profiles
       SET approval_status = $2::text,
           approval_notes  = COALESCE($3::text, approval_notes),
           approved_at     = CASE WHEN $2::text = 'approved' THEN now() ELSE approved_at END,
           updated_at      = now()
       WHERE user_id = $1
       RETURNING user_id AS id, approval_status, approval_notes, approved_at`,
      [driverId, status, notes],
    );
    if (rows.length === 0) throw new NotFoundException('Conductor no encontrado');

    // Si lo sacaste de 'approved' y estaba online, lo bajamos ya mismo
    // y le avisamos a su app.
    if (status !== 'approved') {
      await this.driversService.setDriverOffline(driverId);
      this.driversGateway.notifyDriver(driverId, 'driver:blocked', { reason: status, notes });
      this.driversGateway.disconnectDriver(driverId);
    } else {
      this.driversGateway.notifyDriver(driverId, 'driver:approved', {});
    }

    this.logger.log(`Conductor ${driverId} -> ${status}`);
    return rows[0];
  }

  async listTrips(scope: 'active' | 'today' | 'all') {
    const where =
      scope === 'active'
        ? `t.status = ANY($1::text[])`
        : scope === 'today'
          ? `t.requested_at >= date_trunc('day', now() AT TIME ZONE 'America/Asuncion') AT TIME ZONE 'America/Asuncion' AND $1::text[] IS NOT NULL`
          : `$1::text[] IS NOT NULL`;
    const { rows } = await pool.query(
      `SELECT
         t.id, t.status, t.payment_method, t.requested_at, t.matched_at, t.started_at,
         t.completed_at, t.cancelled_at, t.commission_amount, t.commission_paid_at, t.fare_gs,
         ST_Y(t.pickup_location::geometry) AS pickup_lat,
         ST_X(t.pickup_location::geometry) AS pickup_lon,
         CASE WHEN t.dropoff_location IS NULL THEN NULL ELSE ST_Y(t.dropoff_location::geometry) END AS dropoff_lat,
         CASE WHEN t.dropoff_location IS NULL THEN NULL ELSE ST_X(t.dropoff_location::geometry) END AS dropoff_lon,
         p.full_name AS passenger_name, p.phone AS passenger_phone,
         d.full_name AS driver_name, d.phone AS driver_phone
       FROM trips t
       JOIN users p ON p.id = t.passenger_id
       LEFT JOIN users d ON d.id = t.driver_id
       WHERE ${where}
       ORDER BY t.requested_at DESC
       LIMIT 200`,
      [ACTIVE_TRIP_STATUSES],
    );
    return rows;
  }

  async cancelTrip(tripId: string) {
    const { rows } = await pool.query(`SELECT status, driver_id FROM trips WHERE id = $1`, [tripId]);
    const trip = rows[0];
    if (!trip) throw new NotFoundException('Viaje no encontrado');
    if (!ACTIVE_TRIP_STATUSES.includes(trip.status) && trip.status !== 'no_drivers_available') {
      throw new BadRequestException(`No se puede cancelar un viaje en estado '${trip.status}'`);
    }
    await pool.query(`UPDATE trips SET status = 'cancelled_by_admin', cancelled_at = now() WHERE id = $1`, [tripId]);

    const payload = { trip_id: tripId, cancelled_by: 'admin' };
    this.tripsGateway.notifyTrip(tripId, 'trip:cancelled', payload);
    if (trip.driver_id) {
      this.driversGateway.setActiveTrip(trip.driver_id, null);
      this.driversGateway.notifyDriver(trip.driver_id, 'trip:cancelled', payload);
    }
    this.logger.log(`Viaje ${tripId}: cancelado por admin`);
  }

  async listPassengers(search?: string) {
    const term = search?.trim() ? `%${search.trim()}%` : null;
    const { rows } = await pool.query(
      `SELECT
         u.id, u.full_name, u.phone, u.document_number, u.rating, u.rating_count, u.created_at,
         COALESCE(u.blocked, FALSE) AS blocked,
         COUNT(t.id) FILTER (WHERE t.status = 'completed')::int AS completed_trips,
         COUNT(t.id) FILTER (WHERE t.status = 'cancelled_by_passenger')::int AS cancelled_trips,
         MAX(t.requested_at) AS last_trip_at
       FROM users u
       LEFT JOIN trips t ON t.passenger_id = u.id
       WHERE u.role = 'passenger' AND u.is_active = TRUE
         AND ($1::text IS NULL OR u.full_name ILIKE $1 OR u.phone ILIKE $1)
       GROUP BY u.id
       ORDER BY u.created_at DESC
       LIMIT 300`,
      [term],
    );
    return rows;
  }

  async setUserBlocked(userId: string, blocked: boolean) {
    const { rows } = await pool.query(
      `UPDATE users SET blocked = $2, updated_at = now() WHERE id = $1 AND role <> 'admin'
       RETURNING id, full_name, blocked`,
      [userId, blocked],
    );
    if (rows.length === 0) throw new NotFoundException('Usuario no encontrado');
    this.logger.log(`Usuario ${userId} -> ${blocked ? 'bloqueado' : 'desbloqueado'}`);
    return rows[0];
  }

  async listCommissions() {
    const { rows } = await pool.query(
      `SELECT
         u.id AS driver_id, u.full_name, u.phone, dp.approval_status,
         COUNT(t.id)::int AS unpaid_trips,
         COALESCE(SUM(t.commission_amount), 0)::int AS amount_owed,
         MIN(t.completed_at) AS oldest_unpaid_at,
         MAX(t.completed_at) AS last_trip_at
       FROM trips t
       JOIN users u ON u.id = t.driver_id
       JOIN driver_profiles dp ON dp.user_id = u.id
       WHERE t.status = 'completed' AND t.commission_paid_at IS NULL
       GROUP BY u.id, u.full_name, u.phone, dp.approval_status
       ORDER BY amount_owed DESC`,
    );
    return rows;
  }

  async markCommissionsPaid(driverId: string) {
    const { rows } = await pool.query(
      `UPDATE trips SET commission_paid_at = now()
       WHERE driver_id = $1 AND status = 'completed' AND commission_paid_at IS NULL
       RETURNING commission_amount`,
      [driverId],
    );
    const total = rows.reduce((sum, r) => sum + Number(r.commission_amount), 0);
    this.logger.log(`Conductor ${driverId}: ${rows.length} comisiones marcadas como pagadas (Gs. ${total})`);
    return { trips_marked: rows.length, amount: total };
  }
}
