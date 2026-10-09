import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { APPROVAL_STATUSES, AdminService, ApprovalStatus } from './admin.service';

// Todo /admin/* exige "Authorization: Bearer <token>" de una cuenta
// con role 'admin'. Lo consume el panel web de MC2.
//
// GET   /admin/stats                         -> números del día
// GET   /admin/drivers?status=pending        -> conductores (filtro opcional)
// PATCH /admin/drivers/:id/status            -> { status, notes? }
// GET   /admin/trips?scope=active|today|all  -> viajes
// POST  /admin/trips/:id/cancel              -> cancela cualquier viaje no terminado
// GET   /admin/commissions                   -> deuda de comisión por conductor
// POST  /admin/commissions/:driverId/paid    -> marca todo lo adeudado como pagado
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('stats')
  stats() {
    return this.adminService.getStats();
  }

  @Get('drivers')
  async drivers(@Query('status') status?: string) {
    if (status && !APPROVAL_STATUSES.includes(status as ApprovalStatus)) {
      throw new BadRequestException(`status tiene que ser uno de: ${APPROVAL_STATUSES.join(', ')}`);
    }
    return { drivers: await this.adminService.listDrivers(status as ApprovalStatus | undefined) };
  }

  @Patch('drivers/:id/status')
  async setDriverStatus(@Param('id') id: string, @Body() body: { status?: string; notes?: string }) {
    if (!body?.status || !APPROVAL_STATUSES.includes(body.status as ApprovalStatus)) {
      throw new BadRequestException(`status tiene que ser uno de: ${APPROVAL_STATUSES.join(', ')}`);
    }
    const notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null;
    return { driver: await this.adminService.setDriverStatus(id, body.status as ApprovalStatus, notes) };
  }

  @Get('trips')
  async trips(@Query('scope') scope?: string) {
    const s = scope === 'today' || scope === 'all' ? scope : 'active';
    return { trips: await this.adminService.listTrips(s) };
  }

  @Post('trips/:id/cancel')
  async cancelTrip(@Param('id') id: string) {
    await this.adminService.cancelTrip(id);
    return { ok: true };
  }

  @Get('commissions')
  async commissions() {
    return { drivers: await this.adminService.listCommissions() };
  }

  @Post('commissions/:driverId/paid')
  async markPaid(@Param('driverId') driverId: string) {
    return this.adminService.markCommissionsPaid(driverId);
  }
}
