import { BadRequestException, Body, Controller, Delete, Get, Patch, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { UsersService } from './users.service';
import { AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';

// GET    /users/me            -> datos del usuario logueado
// PATCH  /users/me/password   -> { currentPassword, newPassword }
// DELETE /users/me            -> elimina (desactiva) la cuenta propia
//
// Todo requiere "Authorization: Bearer <token>"; el id sale del token,
// nunca del body, para que nadie pueda tocar la cuenta de otro.
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getMe(@Req() req: Request) {
    const user = (req as Request & { user: AuthUser }).user;
    return this.usersService.getMe(user.sub);
  }

  @Patch('me/password')
  @UseGuards(JwtAuthGuard)
  async changePassword(
    @Body() body: { currentPassword?: string; newPassword?: string },
    @Req() req: Request,
  ) {
    if (!body?.currentPassword || !body?.newPassword) {
      throw new BadRequestException('currentPassword y newPassword son requeridos');
    }
    const user = (req as Request & { user: AuthUser }).user;
    await this.usersService.changePassword(user.sub, body.currentPassword, body.newPassword);
    return { ok: true };
  }

  @Delete('me')
  @UseGuards(JwtAuthGuard)
  async deleteMe(@Req() req: Request) {
    const user = (req as Request & { user: AuthUser }).user;
    await this.usersService.deactivate(user.sub);
    return { ok: true };
  }
}
