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
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AuthUser } from '../auth/jwt-auth.guard';
import { COMMISSION_DEBT_LIMIT, DriversService } from './drivers.service';

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
  // null cuando el pasajero eligió "No informar destino".
  dropoff: { lat: number; lon: number } | null;
  // 'efectivo' | 'transferencia' | 'pix'
  paymentMethod: string;
}

interface TripRespondPayload {
  tripId: string;
  accept: boolean;
}

@WebSocketGateway({ cors: { origin: '*' } })
export class DriversGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(DriversGateway.name);

  // Mismo servidor de Socket.IO que usa TripsGateway (comparten el
  // namespace por defecto) -- lo usamos para mandarle la ubicación en
  // vivo del conductor a la sala del viaje (trip:<id>) sin tener que
  // inyectar TripsGateway acá, lo que crearía una dependencia circular
  // entre TripsModule y DriversModule.
  @WebSocketServer()
  server: Server;

  // driverId -> socket activo. Nos deja mandarle una oferta de viaje
  // directo a SU conexión, sin tener que hacer broadcast a todos.
  private readonly driverSockets = new Map<string, Socket>();

  // driverId -> tripId del viaje activo (accepted / in_progress). Lo
  // pone TripsService cuando se acepta un viaje y lo limpia cuando
  // termina o se cancela -- así sabemos a qué sala mandar cada
  // driver:ping sin consultar la base de datos en cada ping.
  private readonly driverActiveTrip = new Map<string, string>();

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

    // Solo conductores aprobados desde el panel de admin pueden
    // ponerse online. 'driver:blocked' trae el motivo para que la app
    // muestre "Tu cuenta está en revisión" / "suspendida", y
    // 'driver:error' lo cubre en versiones de la app que no lo conocen.
    const approval = await this.driversService.getApprovalStatus(driverId);
    if (approval !== 'approved') {
      const reason = approval ?? 'not_found';
      const messages: Record<string, string> = {
        pending: 'Tu cuenta de conductor está en revisión. Te avisamos por WhatsApp cuando esté aprobada.',
        suspended: 'Tu cuenta de conductor está suspendida. Comunicate con MC2.',
        rejected: 'Tu solicitud de conductor no fue aprobada. Comunicate con MC2.',
        not_found: 'No encontramos tu perfil de conductor.',
      };
      client.emit('driver:blocked', { reason });
      client.emit('driver:error', { message: messages[reason] ?? messages.not_found });
      return;
    }

    // Bloqueo por deuda de comisión (como inDrive/Bolt): hasta que pague
    // y lo marques en el panel, no recibe viajes.
    const debt = await this.driversService.getCommissionDebt(driverId);
    if (debt >= COMMISSION_DEBT_LIMIT) {
      const amount = debt.toLocaleString('es-PY');
      client.emit('driver:blocked', { reason: 'debt', amount: debt });
      client.emit('driver:error', {
        message: `Tenés Gs. ${amount} de comisión pendiente. Pagá a MC2 para volver a recibir viajes.`,
      });
      return;
    }

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

    // Si tiene un viaje activo, el pasajero está esperando verlo llegar
    // en el mapa -- le mandamos la posición a la sala de ese viaje.
    const tripId = this.driverActiveTrip.get(driverId);
    if (tripId) {
      this.server.to(`trip:${tripId}`).emit('trip:driver_location', { lat: payload.lat, lon: payload.lon });
    }
  }

  // TripsService llama esto cuando un viaje pasa a estar activo para
  // este conductor (aceptado) y cuando deja de estarlo (completado o
  // cancelado), para saber a qué viaje mandarle la ubicación en vivo.
  setActiveTrip(driverId: string, tripId: string | null): void {
    if (tripId) {
      this.driverActiveTrip.set(driverId, tripId);
    } else {
      this.driverActiveTrip.delete(driverId);
    }
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

  // Lo saca de la lista de conductores conectados (lo usa el panel de
  // admin al suspender). No cierra el socket para que la app reciba el
  // aviso de driver:blocked que se manda justo antes.
  disconnectDriver(driverId: string): void {
    const socket = this.driverSockets.get(driverId);
    if (socket) {
      socket.data.driverId = undefined;
      this.driverSockets.delete(driverId);
    }
  }

  // Manda un evento directo al socket ya abierto de un conductor
  // puntual (por ejemplo, avisarle que el pasajero canceló el viaje).
  // No hace nada si el conductor no está conectado en este momento.
  notifyDriver(driverId: string, event: string, payload: unknown): void {
    this.driverSockets.get(driverId)?.emit(event, payload);
  }
}
