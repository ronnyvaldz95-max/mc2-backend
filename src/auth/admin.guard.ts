import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';

// Igual que JwtAuthGuard, pero además exige role === 'admin'.
// Para hacer admin a una cuenta: node scripts/make-admin.js <telefono>
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly jwtGuard: JwtAuthGuard) {}

  canActivate(context: ExecutionContext): boolean {
    this.jwtGuard.canActivate(context);
    const req = context.switchToHttp().getRequest();
    if (req.user?.role !== 'admin') {
      throw new ForbiddenException('Solo un administrador puede hacer esto');
    }
    return true;
  }
}
