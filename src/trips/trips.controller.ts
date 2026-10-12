import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { TripsService } from './trips.service';
import { AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';

interface LatLonDto {
  lat: number;
  lon: number;
}

const PAYMENT_METHODS = ['efectivo', 'transferencia', 'pix'] as const;
type PaymentMethod = (typeof PAYMENT_METHODS)[number];

interface CreateTripDto {
  pickup: LatLonDto;
  // Puede venir null/ausente cuando el pasajero eligió "No informar
  // destino" (por ejemplo, no sabe la dirección exacta todavía) -- el
  // conductor y el pasajero lo coordinan de palabra al encontrarse.
  dropoff?: LatLonDto | null;
  // Si no se manda, queda 'efectivo' (el default de la columna en la
  // base de datos y también el de la app).
  paymentMethod?: PaymentMethod;
  // 'auto' (default) o 'moto'
  vehicleCategory?: 'auto' | 'moto';
}

function isValidLatLon(v: unknown): v is LatLonDto {
  return !!v && typeof (v as LatLonDto).lat === 'number' && typeof (v as LatLonDto).lon === 'number';
}

function isValidPaymentMethod(v: unknown): v is PaymentMethod {
  return typeof v === 'string' && (PAYMENT_METHODS as readonly string[]).includes(v);
}

interface RateTripDto {
  score: number;
  comment?: string;
}

interface SendMessageDto {
  text: string;
}

// POST /trips  (requiere "Authorization: Bearer <token>" de un pasajero)
// Body: { pickup: {lat, lon}, dropoff?: {lat, lon} | null, paymentMethod?: 'efectivo'|'transferencia'|'pix' }
//
// El passengerId ya NO se manda en el body -- se toma del token, para
// que nadie pueda pedir un viaje "a nombre de" otro pasajero.
// Responde enseguida con el trip_id y status 'requested'. El resultado
// real del matching (conductor asignado, o no_drivers_available) llega
// después por WebSocket: conectate y mandá trip:subscribe {tripId}.
@Controller('trips')
export class TripsController {
  constructor(private readonly tripsService: TripsService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  async create(@Body() body: CreateTripDto, @Req() req: Request) {
    if (!isValidLatLon(body?.pickup)) {
      throw new BadRequestException('pickup {lat,lon} es requerido');
    }
    if (body.dropoff != null && !isValidLatLon(body.dropoff)) {
      throw new BadRequestException('dropoff, si se manda, tiene que ser {lat,lon}');
    }
    if (body.paymentMethod != null && !isValidPaymentMethod(body.paymentMethod)) {
      throw new BadRequestException(`paymentMethod, si se manda, tiene que ser uno de: ${PAYMENT_METHODS.join(', ')}`);
    }

    const user = (req as Request & { user: AuthUser }).user;
    if (await this.tripsService.isBlocked(user.sub)) {
      throw new ForbiddenException('Tu cuenta está bloqueada. Comunicate con MC2.');
    }

    const { tripId, fareGs } = await this.tripsService.createTrip({
      passengerId: user.sub,
      pickup: body.pickup,
      dropoff: body.dropoff ?? null,
      paymentMethod: body.paymentMethod ?? 'efectivo',
      vehicleCategory: body.vehicleCategory === 'moto' ? 'moto' : 'auto',
    });

    return { trip_id: tripId, status: 'requested', fare_gs: fareGs };
  }

  // GET /trips/mine  (requiere token de pasajero)
  // Devuelve los últimos viajes del pasajero logueado, más recientes
  // primero -- lo que muestra la pantalla "Actividad" de la app.
  @Get('mine')
  @UseGuards(JwtAuthGuard)
  async mine(@Req() req: Request) {
    const user = (req as Request & { user: AuthUser }).user;
    const trips = await this.tripsService.getMyTrips(user.sub);
    return { trips };
  }

  // GET /trips/passenger/active  (requiere token de pasajero)
  // El viaje en curso del pasajero (para recuperarlo si cerró la app).
  @Get('passenger/active')
  @UseGuards(JwtAuthGuard)
  async passengerActive(@Req() req: Request) {
    const user = (req as Request & { user: AuthUser }).user;
    return { trip: await this.tripsService.getPassengerActiveTrip(user.sub) };
  }

  // GET /trips/driver/active  (requiere token de conductor)
  // El viaje que el conductor tiene aceptado o en curso, o null. La app
  // lo pide al abrirse para recuperar el viaje si se cerró a la mitad.
  @Get('driver/active')
  @UseGuards(JwtAuthGuard)
  async driverActive(@Req() req: Request) {
    const user = (req as Request & { user: AuthUser }).user;
    return { trip: await this.tripsService.getDriverActiveTrip(user.sub) };
  }

  // POST /trips/:id/arrived  (requiere token del CONDUCTOR asignado)
  // El conductor llegó al punto de recogida; se le avisa al pasajero.
  @Post(':id/arrived')
  @UseGuards(JwtAuthGuard)
  async arrived(@Param('id') id: string, @Req() req: Request) {
    const user = (req as Request & { user: AuthUser }).user;
    await this.tripsService.arrivedTrip(id, user.sub);
    return { ok: true };
  }

  // POST /trips/:id/start  (requiere token del CONDUCTOR asignado)
  // El conductor marca que arrancó el viaje (recogió al pasajero).
  @Post(':id/start')
  @UseGuards(JwtAuthGuard)
  async start(@Param('id') id: string, @Req() req: Request) {
    const user = (req as Request & { user: AuthUser }).user;
    await this.tripsService.startTrip(id, user.sub);
    return { ok: true };
  }

  // POST /trips/:id/complete  (requiere token del CONDUCTOR asignado)
  // El conductor marca que terminó el viaje (dejó al pasajero).
  @Post(':id/complete')
  @UseGuards(JwtAuthGuard)
  async complete(@Param('id') id: string, @Req() req: Request, @Body() body: { lat?: number; lon?: number } = {}) {
    const user = (req as Request & { user: AuthUser }).user;
    // La app manda (opcional) dónde terminó, para cerrar el precio de
    // un viaje sin destino.
    const end = body && isValidLatLon(body) ? { lat: body.lat as number, lon: body.lon as number } : null;
    const result = await this.tripsService.completeTrip(id, user.sub, end);
    return { ok: true, ...result };
  }

  // POST /trips/:id/cancel  (requiere token del PASAJERO dueño o del
  // CONDUCTOR asignado). Solo se puede cancelar antes de que el viaje
  // esté en curso (in_progress) o ya completado.
  @Post(':id/cancel')
  @UseGuards(JwtAuthGuard)
  async cancel(@Param('id') id: string, @Req() req: Request) {
    const user = (req as Request & { user: AuthUser }).user;
    await this.tripsService.cancelTrip(id, user.sub, user.role);
    return { ok: true };
  }

  // POST /trips/:id/rate  (requiere token del pasajero o del conductor
  // del viaje). Solo se puede calificar un viaje ya 'completed'. Si se
  // llama dos veces, la segunda actualiza la calificación anterior en
  // vez de duplicarla.
  @Post(':id/rate')
  @UseGuards(JwtAuthGuard)
  async rate(@Param('id') id: string, @Body() body: RateTripDto, @Req() req: Request) {
    if (typeof body?.score !== 'number' || !Number.isInteger(body.score) || body.score < 1 || body.score > 5) {
      throw new BadRequestException('score tiene que ser un entero entre 1 y 5');
    }
    const comment = typeof body?.comment === 'string' && body.comment.trim() ? body.comment.trim() : null;
    const user = (req as Request & { user: AuthUser }).user;
    await this.tripsService.rateTrip(id, user.sub, user.role, body.score, comment);
    return { ok: true };
  }

  // POST /trips/:id/messages  (requiere token del pasajero o del
  // conductor de ESE viaje). Manda un mensaje de chat; el otro lado lo
  // recibe en vivo por WebSocket (trip:chat:message), no hace falta
  // pedirlo de nuevo por acá.
  @Post(':id/messages')
  @UseGuards(JwtAuthGuard)
  async sendMessage(@Param('id') id: string, @Body() body: SendMessageDto, @Req() req: Request) {
    if (typeof body?.text !== 'string' || !body.text.trim()) {
      throw new BadRequestException('text es requerido');
    }
    const user = (req as Request & { user: AuthUser }).user;
    const message = await this.tripsService.sendChatMessage(id, user.sub, user.role, body.text);
    return { message };
  }

  // GET /trips/:id/messages  (requiere token del pasajero o del
  // conductor de ESE viaje). Historial completo, más antiguo primero
  // -- para cuando se abre la pantalla de chat.
  @Get(':id/messages')
  @UseGuards(JwtAuthGuard)
  async getMessages(@Param('id') id: string, @Req() req: Request) {
    const user = (req as Request & { user: AuthUser }).user;
    const messages = await this.tripsService.getChatMessages(id, user.sub, user.role);
    return { messages };
  }
}
