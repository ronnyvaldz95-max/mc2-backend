import { BadRequestException, Body, Controller, ForbiddenException, Get, Patch, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DriversService } from './drivers.service';

// GET /drivers/nearby?lat=-22.548&lon=-55.7335&radius=3000&max=5
//
// Devuelve la lista de conductores online más cercanos a un punto de
// recogida, ordenados por distancia. Cuando la lista viene vacía, el
// front debe tratarlo como el estado 'no_drivers_available' de trips.status.
@Controller('drivers')
export class DriversController {
  constructor(private readonly driversService: DriversService) {}

  // GET /drivers/me/stats  (requiere token de conductor)
  // Para la pantalla "Mis ganancias" de la app.
  @Get('me/stats')
  @UseGuards(JwtAuthGuard)
  async myStats(@Req() req: Request) {
    const user = (req as Request & { user: AuthUser }).user;
    if (user.role !== 'driver') throw new ForbiddenException('Solo para conductores');
    return this.driversService.getDriverStats(user.sub);
  }

  // PATCH /drivers/me/payout  { transferAlias?, pixKey? }
  @Patch('me/payout')
  @UseGuards(JwtAuthGuard)
  async setPayout(@Req() req: Request, @Body() body: { transferAlias?: string; pixKey?: string }) {
    const user = (req as Request & { user: AuthUser }).user;
    if (user.role !== 'driver') throw new ForbiddenException('Solo para conductores');
    return this.driversService.setPayout(user.sub, body?.transferAlias ?? null, body?.pixKey ?? null);
  }

  @Get('nearby')
  async nearby(
    @Query('lat') latRaw: string,
    @Query('lon') lonRaw: string,
    @Query('radius') radiusRaw?: string,
    @Query('max') maxRaw?: string,
  ) {
    const lat = Number(latRaw);
    const lon = Number(lonRaw);
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      throw new BadRequestException('lat y lon son requeridos y deben ser numéricos');
    }

    const radiusMeters = radiusRaw ? Number(radiusRaw) : 3000;
    const maxResults = maxRaw ? Number(maxRaw) : 5;

    const drivers = await this.driversService.findNearbyDrivers(
      lat,
      lon,
      radiusMeters,
      maxResults,
    );

    return {
      status: drivers.length === 0 ? 'no_drivers_available' : 'ok',
      pickup: { lat, lon },
      radius_m: radiusMeters,
      drivers,
    };
  }
}
