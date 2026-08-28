import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export interface AuthUser {
  sub: string; // user id
  role: 'passenger' | 'driver' | 'admin';
  name: string;
}

// Guard genérico: exige "Authorization: Bearer <token>" válido y
// deja el usuario decodificado en req.user para que el controller
// lo use (por ejemplo, como passengerId en POST /trips).
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const header = req.headers?.authorization as string | undefined;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Falta el token (Authorization: Bearer <token>)');
    }
    const token = header.slice('Bearer '.length);
    try {
      req.user = this.jwtService.verify<AuthUser>(token);
      return true;
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }
  }
}
