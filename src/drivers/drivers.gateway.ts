// =============================================================
// Gateway WebSocket para el ciclo de vida de un conductor:
//   1. driver:online  -> el conductor se conecta y pasa a disponible
//      (requiere un JWT válido de un usuario con role 'driver';
//      el driverId sale del token, nunca de lo que mande el cliente)
//   2. driver:ping    -> ping de posición cada 3-5s mientras maneja
//   3. driver:offline / desconexión -> deja de estar disponible
//
// También expone offerTrip(), que usa TripsService para ofrecerle
// un viaje a un conductor puntual por su socket ya abierto, y
// escucha trip:respond con la decisión del conductor.
// =============================================================
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { AuthUser } from '../auth/jwt-auth.guard';
import { DriversService } from './drivers.service';

interface DriverOnlinePayload {
  token: string;
  lat: number;
  lon: number;
}

interface DriverPingPayload {
  lat: number;
  lon: number;
}

export interface TripOfferPayload {
  tripId: string;
  pickup: { lat: number; lon: number };
  dropoff: { lat: number; lon: number };
}

interface TripRespondPayload {
  tripId: string;
  accept: boolean;
}

@WebSocketGateway({ cors: { origin: '*' } })
export class DriversGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(DriversGateway.name);

  // driverId -> socket activo. Nos deja mandarle una oferta de viaje
  // directo a SU conexión, sin tener que hacer broadcast a todos.
  private readonly driverSockets = new Map<string, Socket>();

  // tripId -> oferta pendiente de respuesta de ese conductor puntual.
  private readonly pendingTripOffers = new Map<string, { driverId: string; resolve: (accepted: boolean) => void }>();

  constructor(
    private readonly driversService: DriversService,
    private readonly jwtService: JwtService,
  ) {}

  handleConnection(client: Socket) {
    this.logger.log(`Socket conectado: ${client.id}`);
  }

  // Si el conductor cierra la app / pierde conexión sin avisar, lo
  // sacamos igual del índice de conductores disponibles.
  async handleDisconnect(client: Socket) {
    const driverId = client.data?.driverId as string | undefined;
    if (driverId) {
      this.driverSockets.delete(driverId);
      await this.driversService.setDriverOffline(driverId);
    }
    this.logger.log(`Socket desconectado: ${client.id}`);
  }

  @SubscribeMessage('driver:online')
  async onDriverOnline(@MessageBody() payload: DriverOnlinePayload, @ConnectedSocket() client: Socket) {
    if (!payload?.token || typeof payload.lat !== 'number' || typeof payload.lon !== 'number') {
      client.emit('driver:error', { message: 'token, lat y lon son requeridos' });
      return;
    }

    let decoded: AuthUser;
    try {
      decoded = this.jwtService.verify<AuthUser>(payload.token);
    } catch {
      client.emit('driver:error', { message: 'Token inválido o expirado' });
      return;
    }
    if (decoded.role !== 'driver') {
      client.emit('driver:error', { message: 'Este token no pertenece a un conductor' });
      return;
    }

    const driverId = decoded.sub;
    client.data.driverId = driverId;
    this.driverSockets.set(driverId, client);
    await this.driversService.setDriverOnline(driverId, payload.lat, payload.lon);
    client.emit('driver:online:ack', { ok: true, driverId });
  }

  @SubscribeMessage('driver:ping')
  async onDriverPing(@MessageBody() payload: DriverPingPayload, @ConnectedSocket() client: Socket) {
    const driverId = client.data?.driverId as string | undefined;
    if (!driverId) {
      client.emit('driver:error', { message: 'Mandá driver:online antes de driver:ping' });
      return;
    }
    if (typeof payload?.lat !== 'number' || typeof payload?.lon !== 'number') {
      client.emit('driver:error', { message: 'lat y lon son requeridos' });
      return;
    }
    await this.driversService.updateDriverLocation(driverId, payload.lat, payload.lon);
  }

  @SubscribeMessage('driver:offline')
  async onDriverOffline(@ConnectedSocket() client: Socket) {
    const driverId = client.data?.driverId as string | undefined;
    if (driverId) {
      this.driverSockets.delete(driverId);
      await this.driversService.setDriverOffline(driverId);
      client.data.driverId = undefined;
    }
  }

  // El conductor acepta o rechaza una oferta de viaje que le mandamos
  // por offerTrip(). Se correlaciona por tripId.
  @SubscribeMessage('trip:respond')
  onTripRespond(@MessageBody() payload: TripRespondPayload, @ConnectedSocket() client: Socket) {
    const pending = this.pendingTripOffers.get(payload?.tripId);
    if (!pending) return; // ya expiró el timeout, o el tripId no existe
    const driverId = client.data?.driverId as string | undefined;
    if (pending.driverId !== driverId) return; // ignorar respuestas de otro socket
    this.pendingTripOffers.delete(payload.tripId);
    pending.resolve(!!payload.accept);
  }

  /**
   * Le ofrece un viaje puntual a UN conductor por su socket ya abierto.
   * Devuelve true si aceptó, false si rechazó, no respondió a tiempo,
   * o ya no está conectado.
   */
  offerTrip(driverId: string, offer: TripOfferPayload, timeoutMs = 15_000): Promise<boolean> {
    const socket = this.driverSockets.get(driverId);
    if (!socket) return Promise.resolve(false);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingTripOffers.delete(offer.tripId);
        resolve(false);
      }, timeoutMs);

      this.pendingTripOffers.set(offer.tripId, {
        driverId,
        resolve: (accepted: boolean) => {
          clearTimeout(timer);
          resolve(accepted);
        },
      });

      socket.emit('trip:offer', offer);
    });
  }
}
