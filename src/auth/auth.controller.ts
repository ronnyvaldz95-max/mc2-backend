import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';

// POST /auth/register/passenger  { fullName, phone, password }
// POST /auth/register/driver     { fullName, phone, password, licenseNumber,
//                                   vehicle: { plate, brand?, model?, color?, vehicleType } }
// POST /auth/login               { phone, password }
//
// Los tres devuelven { access_token, user: { id, full_name, role } }.
// access_token va en el header "Authorization: Bearer <token>" para
// pedidos protegidos (POST /trips), o en el payload de driver:online
// por WebSocket.
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register/passenger')
  registerPassenger(@Body() body: any) {
    return this.authService.registerPassenger(body);
  }

  @Post('register/driver')
  registerDriver(@Body() body: any) {
    return this.authService.registerDriver(body);
  }

  @Post('login')
  login(@Body() body: { phone: string; password: string }) {
    return this.authService.login(body?.phone, body?.password);
  }
}
