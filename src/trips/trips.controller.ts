import { BadRequestException, Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { TripsService } from './trips.service';
import { AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';

interface LatLonDto {
  lat: number;
  lon: number;
}

interface CreateTripDto {
  pickup: LatLonDto;
  // Puede venir null/ausente cuando el pasajero eligió "No informar
  // destino" (por ejemplo, no sabe la dirección exacta todavía) -- el
  // conductor y el pasajero lo coordinan de palabra al encontrarse.
  dropoff?: LatLonDto | null;
}

function isValidLatLon(v: unknown): v is LatLonDto {
  return !!v && typeof (v as LatLonDto).lat === 'number' && typeof (v as LatLonDto).lon === 'number';
}

// POST /trips  (requiere "Authorization: Bearer <token>" de un pasajero)
// Body: { pickup: {lat, lon}, dropoff?: {lat, lon} | null }
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

    const user = (req as Request & { user: AuthUser }).user;

    const { tripId } = await this.tripsService.createTrip({
      passengerId: user.sub,
      pickup: body.pickup,
      dropoff: body.dropoff ?? null,
    });

    return { trip_id: tripId, status: 'requested' };
  }
}
