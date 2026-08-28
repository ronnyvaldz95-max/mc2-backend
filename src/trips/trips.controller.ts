import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { TripsService } from './trips.service';

interface LatLonDto {
  lat: number;
  lon: number;
}

interface CreateTripDto {
  passengerId: string;
  pickup: LatLonDto;
  dropoff: LatLonDto;
}

function isValidLatLon(v: unknown): v is LatLonDto {
  return !!v && typeof (v as LatLonDto).lat === 'number' && typeof (v as LatLonDto).lon === 'number';
}

// POST /trips
// Body: { passengerId, pickup: {lat, lon}, dropoff: {lat, lon} }
//
// Responde enseguida con el trip_id y status 'requested'. El resultado
// real del matching (conductor asignado, o no_drivers_available) llega
// después por WebSocket: conectate y mandá trip:subscribe {tripId}.
@Controller('trips')
export class TripsController {
  constructor(private readonly tripsService: TripsService) {}

  @Post()
  async create(@Body() body: CreateTripDto) {
    if (!body?.passengerId || !isValidLatLon(body.pickup) || !isValidLatLon(body.dropoff)) {
      throw new BadRequestException('passengerId, pickup {lat,lon} y dropoff {lat,lon} son requeridos');
    }

    const { tripId } = await this.tripsService.createTrip({
      passengerId: body.passengerId,
      pickup: body.pickup,
      dropoff: body.dropoff,
    });

    return { trip_id: tripId, status: 'requested' };
  }
}
