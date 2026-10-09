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
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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

    // A partir de ahora, cada driver:ping de este conductor le manda su
    // ubicación en vivo al pasajero de este viaje (ver DriversGateway).
    this.driversGateway.setActiveTrip(driverId, tripId);

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
         v.plate AS driver_plate,
         EXISTS (
           SELECT 1 FROM ratings r WHERE r.trip_id = t.id AND r.rated_by = $1
         ) AS rated_by_me
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

  // Viaje activo (aceptado o en curso) de un conductor, o null.
  async getDriverActiveTrip(driverId: string) {
    const { rows } = await pool.query(
      `SELECT
         t.id, t.status, t.payment_method,
         ST_Y(t.pickup_location::geometry) AS pickup_lat,
         ST_X(t.pickup_location::geometry) AS pickup_lon,
         CASE WHEN t.dropoff_location IS NULL THEN NULL ELSE ST_Y(t.dropoff_location::geometry) END AS dropoff_lat,
         CASE WHEN t.dropoff_location IS NULL THEN NULL ELSE ST_X(t.dropoff_location::geometry) END AS dropoff_lon
       FROM trips t
       WHERE t.driver_id = $1 AND t.status IN ('accepted', 'arrived', 'in_progress')
       ORDER BY t.matched_at DESC NULLS LAST
       LIMIT 1`,
      [driverId],
    );
    const t = rows[0];
    if (!t) return null;
    return {
      trip_id: t.id,
      status: t.status,
      payment_method: t.payment_method,
      pickup: { lat: Number(t.pickup_lat), lon: Number(t.pickup_lon) },
      dropoff: t.dropoff_lat == null ? null : { lat: Number(t.dropoff_lat), lon: Number(t.dropoff_lon) },
    };
  }

  // El conductor asignado marca que arrancó el viaje (recogió al
  // pasajero). Solo válido desde 'accepted'.
  async startTrip(tripId: string, driverId: string): Promise<void> {
    const { rows } = await pool.query(`SELECT status, driver_id FROM trips WHERE id = $1`, [tripId]);
    const trip = rows[0];
    if (!trip) throw new NotFoundException('Viaje no encontrado');
    if (trip.driver_id !== driverId) throw new ForbiddenException('Este viaje no te fue asignado');
    if (trip.status !== 'accepted') {
      throw new BadRequestException(`No se puede iniciar un viaje en estado '${trip.status}'`);
    }
    await pool.query(`UPDATE trips SET status = 'in_progress', started_at = now() WHERE id = $1`, [tripId]);
    this.tripsGateway.notifyTrip(tripId, 'trip:started', { trip_id: tripId });
    this.logger.log(`Viaje ${tripId}: iniciado por conductor ${driverId}`);
  }

  // El conductor asignado marca que terminó el viaje (dejó al
  // pasajero). Solo válido desde 'in_progress'.
  async completeTrip(tripId: string, driverId: string): Promise<void> {
    const { rows } = await pool.query(`SELECT status, driver_id FROM trips WHERE id = $1`, [tripId]);
    const trip = rows[0];
    if (!trip) throw new NotFoundException('Viaje no encontrado');
    if (trip.driver_id !== driverId) throw new ForbiddenException('Este viaje no te fue asignado');
    if (trip.status !== 'in_progress') {
      throw new BadRequestException(`No se puede finalizar un viaje en estado '${trip.status}'`);
    }
    await pool.query(`UPDATE trips SET status = 'completed', completed_at = now() WHERE id = $1`, [tripId]);
    this.driversGateway.setActiveTrip(driverId, null);
    this.tripsGateway.notifyTrip(tripId, 'trip:completed', { trip_id: tripId });
    this.logger.log(`Viaje ${tripId}: completado por conductor ${driverId}`);
  }

  // El pasajero dueño, o el conductor asignado, cancelan el viaje.
  // Solo antes de que esté en curso o completado -- una vez
  // 'in_progress' ya no se puede cancelar (conviene completarlo).
  async cancelTrip(tripId: string, requesterId: string, requesterRole: string): Promise<void> {
    const { rows } = await pool.query(`SELECT status, driver_id, passenger_id FROM trips WHERE id = $1`, [tripId]);
    const trip = rows[0];
    if (!trip) throw new NotFoundException('Viaje no encontrado');

    const isPassenger = requesterRole === 'passenger' && trip.passenger_id === requesterId;
    const isDriver = requesterRole === 'driver' && trip.driver_id === requesterId;
    if (!isPassenger && !isDriver) throw new ForbiddenException('No podés cancelar este viaje');

    if (!['requested', 'matched', 'accepted', 'no_drivers_available'].includes(trip.status)) {
      throw new BadRequestException(`No se puede cancelar un viaje en estado '${trip.status}'`);
    }

    const newStatus = isDriver ? 'cancelled_by_driver' : 'cancelled_by_passenger';
    await pool.query(`UPDATE trips SET status = $2, cancelled_at = now() WHERE id = $1`, [tripId, newStatus]);

    if (trip.driver_id) {
      this.driversGateway.setActiveTrip(trip.driver_id, null);
    }

    const cancelledBy = isDriver ? 'driver' : 'passenger';
    this.tripsGateway.notifyTrip(tripId, 'trip:cancelled', { trip_id: tripId, cancelled_by: cancelledBy });
    if (isPassenger && trip.driver_id) {
      this.driversGateway.notifyDriver(trip.driver_id, 'trip:cancelled', { trip_id: tripId, cancelled_by: cancelledBy });
    }
    this.logger.log(`Viaje ${tripId}: cancelado por ${isDriver ? 'conductor' : 'pasajero'}`);
  }

  // El pasajero califica al conductor, o el conductor al pasajero, de
  // un viaje ya 'completed'. Llamar de nuevo actualiza la calificación
  // anterior (no se duplica, hay UNIQUE (trip_id, rated_by)). Después
  // de guardarla, recalculamos el promedio del calificado desde la
  // tabla ratings (fuente de verdad), no acumulando a mano.
  async rateTrip(
    tripId: string,
    raterId: string,
    raterRole: string,
    score: number,
    comment: string | null,
  ): Promise<void> {
    const { rows } = await pool.query(
      `SELECT status, driver_id, passenger_id FROM trips WHERE id = $1`,
      [tripId],
    );
    const trip = rows[0];
    if (!trip) throw new NotFoundException('Viaje no encontrado');
    if (trip.status !== 'completed') {
      throw new BadRequestException('Solo se puede calificar un viaje completado');
    }

    const isPassenger = raterRole === 'passenger' && trip.passenger_id === raterId;
    const isDriver = raterRole === 'driver' && trip.driver_id === raterId;
    if (!isPassenger && !isDriver) throw new ForbiddenException('No podés calificar este viaje');

    const ratedUser = isPassenger ? trip.driver_id : trip.passenger_id;
    if (!ratedUser) throw new BadRequestException('Este viaje no tiene a quién calificar');

    await pool.query(
      `INSERT INTO ratings (trip_id, rated_by, rated_user, score, comment)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (trip_id, rated_by)
       DO UPDATE SET score = EXCLUDED.score, comment = EXCLUDED.comment`,
      [tripId, raterId, ratedUser, score, comment],
    );

    await pool.query(
      `UPDATE users u
       SET rating = sub.avg_score, rating_count = sub.cnt
       FROM (
         SELECT rated_user, ROUND(AVG(score)::numeric, 1) AS avg_score, COUNT(*) AS cnt
         FROM ratings WHERE rated_user = $1
         GROUP BY rated_user
       ) sub
       WHERE u.id = sub.rated_user`,
      [ratedUser],
    );

    this.logger.log(
      `Viaje ${tripId}: calificado por ${isPassenger ? 'pasajero' : 'conductor'} con ${score}/5`,
    );
  }

  // --- Chat pasajero <-> conductor de un viaje -------------------------
  //
  // El ENVÍO va por REST (POST /trips/:id/messages, ver trips.controller)
  // -- así reusamos el JwtAuthGuard que ya existe y no hace falta
  // autenticar sockets nuevos. La RECEPCIÓN en vivo del otro lado sigue
  // yendo por los canales de WebSocket que YA existían: tripsGateway
  // (sala trip:<id>, donde el pasajero ya está por trip:subscribe) y
  // driversGateway (socket directo del conductor). No se tocó ningún
  // gateway para esto.

  async sendChatMessage(
    tripId: string,
    senderId: string,
    senderRole: string,
    text: string,
  ): Promise<{
    id: string;
    trip_id: string;
    sender_id: string;
    sender_role: string;
    text: string;
    created_at: string;
  }> {
    const trimmed = text?.trim() ?? '';
    if (!trimmed) throw new BadRequestException('El mensaje no puede estar vacío');
    if (trimmed.length > 1000) throw new BadRequestException('El mensaje es demasiado largo (máx. 1000 caracteres)');

    const { rows } = await pool.query(`SELECT passenger_id, driver_id FROM trips WHERE id = $1`, [tripId]);
    const trip = rows[0];
    if (!trip) throw new NotFoundException('Viaje no encontrado');

    const isPassenger = senderRole === 'passenger' && trip.passenger_id === senderId;
    const isDriver = senderRole === 'driver' && trip.driver_id === senderId;
    if (!isPassenger && !isDriver) throw new ForbiddenException('No formás parte de este viaje');

    const { rows: inserted } = await pool.query(
      `INSERT INTO trip_messages (trip_id, sender_id, sender_role, text)
       VALUES ($1, $2, $3, $4)
       RETURNING id, trip_id, sender_id, sender_role, text, created_at`,
      [tripId, senderId, senderRole, trimmed],
    );
    const message = inserted[0];

    // Avisamos por los DOS canales -- lo recibe quien no lo mandó (el
    // que mandó el mensaje ya lo tiene, se lo agrega solo en la app).
    this.tripsGateway.notifyTrip(tripId, 'trip:chat:message', message);
    if (trip.driver_id) {
      this.driversGateway.notifyDriver(trip.driver_id, 'trip:chat:message', message);
    }

    return message;
  }

  async getChatMessages(tripId: string, requesterId: string, requesterRole: string) {
    const { rows } = await pool.query(`SELECT passenger_id, driver_id FROM trips WHERE id = $1`, [tripId]);
    const trip = rows[0];
    if (!trip) throw new NotFoundException('Viaje no encontrado');

    const isPassenger = requesterRole === 'passenger' && trip.passenger_id === requesterId;
    const isDriver = requesterRole === 'driver' && trip.driver_id === requesterId;
    if (!isPassenger && !isDriver) throw new ForbiddenException('No formás parte de este viaje');

    const { rows: messages } = await pool.query(
      `SELECT id, trip_id, sender_id, sender_role, text, created_at
       FROM trip_messages WHERE trip_id = $1 ORDER BY created_at ASC`,
      [tripId],
    );
    return messages;
  }
}
