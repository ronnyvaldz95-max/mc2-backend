// =============================================================
// Canal WebSocket del lado del PASAJERO: se suscribe a un viaje
// puntual (trip:subscribe) y recibe ahí las novedades (trip:matched,
// trip:no_drivers_available). No maneja lógica de negocio, solo
// las salas de socket.io por trip_id.
// =============================================================
import { WebSocketGateway, WebSocketServer, SubscribeMessage, MessageBody, ConnectedSocket } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({ cors: { origin: '*' } })
export class TripsGateway {
  @WebSocketServer()
  server: Server;

  @SubscribeMessage('trip:subscribe')
  onSubscribe(@MessageBody() payload: { tripId: string }, @ConnectedSocket() client: Socket) {
    if (payload?.tripId) {
      client.join(`trip:${payload.tripId}`);
    }
  }

  notifyTrip(tripId: string, event: string, payload: unknown) {
    this.server.to(`trip:${tripId}`).emit(event, payload);
  }
}
