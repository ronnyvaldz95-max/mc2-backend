import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
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

    const { tripId } = await this.tripsService.createTrip({
      passengerId: user.sub,
      pickup: body.pickup,
      dropoff: body.dropoff ?? null,
      paymentMethod: body.paymentMethod ?? 'efectivo',
    });

    return { trip_id: tripId, status: 'requested' };
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
  async complete(@Param('id') id: string, @Req() req: Request) {
    const user = (req as Request & { user: AuthUser }).user;
    await this.tripsService.completeTrip(id, user.sub);
    return { ok: true };
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
}
