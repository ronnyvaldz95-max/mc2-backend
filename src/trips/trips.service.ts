// =============================================================
// Orquesta el flujo de "pedir un viaje":
//   1. Crea el trip en Postgres (status: requested).
//   2. Busca candidatos con DriversService.findNearbyDrivers().
//   3. Le ofrece el viaje al más cercano (DriversGateway.offerTrip,
//      con timeout); si rechaza o no responde, pasa al siguiente.
//   4. Si alguno acepta -> status: accepted + avisa al pasajero.
//      Si se acaban los candidatos -> status: no_drivers_available.
//
// El destino (dropoff) es opcional: si el pasajero eligió "No informar
// destino", viaja como null de punta a punta y se lo mostramos así al
// conductor, que lo coordina de palabra con el pasajero al recogerlo.
// =============================================================
import { Injectable, Logger } from '@nestjs/common';
import { pool } from '../db';
import { DriversService } from '../drivers/drivers.service';
import { DriversGateway } from '../drivers/drivers.gateway';
import { TripsGateway } from './trips.gateway';

const OFFER_TIMEOUT_MS = 15_000;

export interface LatLon {
  lat: number;
  lon: number;
}

export interface CreateTripInput {
  passengerId: string;
  pickup: LatLon;
  dropoff: LatLon | null;
  paymentMethod: string;
}

@Injectable()
export class TripsService {
  private readonly logger = new Logger(TripsService.name);

  constructor(
    private readonly driversService: DriversService,
    private readonly driversGateway: DriversGateway,
    private readonly tripsGateway: TripsGateway,
  ) {}

  async createTrip(input: CreateTripInput): Promise<{ tripId: string }> {
    const { rows } = await pool.query(
      `INSERT INTO trips (passenger_id, pickup_location, dropoff_location, payment_method, status)
       VALUES ($1,
         ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
         CASE WHEN $4::double precision IS NULL THEN NULL
              ELSE ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography END,
         $6,
         'requested')
       RETURNING id`,
      [
        input.passengerId,
        input.pickup.lon,
        input.pickup.lat,
        input.dropoff?.lon ?? null,
        input.dropoff?.lat ?? null,
        input.paymentMethod,
      ],
    );
    const tripId = rows[0].id;
    this.logger.log(
      `Viaje ${tripId} solicitado por pasajero ${input.passengerId}` +
        (input.dropoff ? '' : ' (sin destino informado)') +
        ` · pago: ${input.paymentMethod}`,
    );

    // No lo esperamos: el pasajero ya tiene su trip_id para hacer
    // trip:subscribe. El resultado del matching le llega por WebSocket
    // cuando esté listo (puede tardar hasta OFFER_TIMEOUT_MS * candidatos).
    void this.matchTrip(tripId, input.pickup, input.dropoff, input.paymentMethod);

    return { tripId };
  }

  private async matchTrip(
    tripId: string,
    pickup: LatLon,
    dropoff: LatLon | null,
    paymentMethod: string,
  ): Promise<void> {
    const candidates = await this.driversService.findNearbyDrivers(pickup.lat, pickup.lon, 3000, 5);

    if (candidates.length === 0) {
      await this.markNoDriversAvailable(tripId);
      return;
    }

    for (const candidate of candidates) {
      this.logger.log(`Viaje ${tripId}: ofreciendo a ${candidate.full_name} (${candidate.driver_id})`);
      const accepted = await this.driversGateway.offerTrip(
        candidate.driver_id,
        { tripId, pickup, dropoff, paymentMethod },
        OFFER_TIMEOUT_MS,
      );
      if (accepted) {
        await this.markAccepted(tripId, candidate.driver_id);
        return;
      }
      this.logger.log(`Viaje ${tripId}: ${candidate.full_name} rechazó o no respondió, sigo con el próximo candidato`);
    }

    await this.markNoDriversAvailable(tripId);
  }

  private async markAccepted(tripId: string, driverId: string): Promise<void> {
    await pool.query(`UPDATE trips SET status = 'accepted', driver_id = $2, matched_at = now() WHERE id = $1`, [
      tripId,
      driverId,
    ]);

    const { rows } = await pool.query(
      `SELECT u.full_name, u.rating, v.vehicle_type, v.plate
       FROM users u
       LEFT JOIN driver_profiles dp ON dp.user_id = u.id
       LEFT JOIN vehicles v ON v.id = dp.active_vehicle_id
       WHERE u.id = $1`,
      [driverId],
    );

    this.tripsGateway.notifyTrip(tripId, 'trip:matched', {
      trip_id: tripId,
      driver: { driver_id: driverId, ...rows[0] },
    });
    this.logger.log(`Viaje ${tripId}: aceptado por conductor ${driverId}`);
  }

  private async markNoDriversAvailable(tripId: string): Promise<void> {
    await pool.query(`UPDATE trips SET status = 'no_drivers_available' WHERE id = $1`, [tripId]);
    this.tripsGateway.notifyTrip(tripId, 'trip:no_drivers_available', { trip_id: tripId });
    this.logger.log(`Viaje ${tripId}: no_drivers_available`);
  }

  // Historial de viajes de un pasajero, para la pantalla "Actividad".
  // dropoff_lat/lon vienen null si el viaje se pidió sin informar
  // destino. driver_name/driver_plate vienen null si nunca se asignó
  // un conductor (por ejemplo, no_drivers_available).
  async getMyTrips(passengerId: string, limit = 30) {
    const { rows } = await pool.query(
      `SELECT
         t.id,
         t.status,
         t.requested_at,
         t.matched_at,
         t.payment_method,
         ST_Y(t.pickup_location::geometry) AS pickup_lat,
         ST_X(t.pickup_location::geometry) AS pickup_lon,
         CASE WHEN t.dropoff_location IS NULL THEN NULL ELSE ST_Y(t.dropoff_location::geometry) END AS dropoff_lat,
         CASE WHEN t.dropoff_location IS NULL THEN NULL ELSE ST_X(t.dropoff_location::geometry) END AS dropoff_lon,
         d.full_name AS driver_name,
         v.plate AS driver_plate
       FROM trips t
       LEFT JOIN users d ON d.id = t.driver_id
       LEFT JOIN driver_profiles dp ON dp.user_id = t.driver_id
       LEFT JOIN vehicles v ON v.id = dp.active_vehicle_id
       WHERE t.passenger_id = $1
       ORDER BY t.requested_at DESC
       LIMIT $2`,
      [passengerId, limit],
    );
    return rows;
  }
}
