// =============================================================
// Datos de "Mi cuenta": ver mis datos, cambiar contraseña, y
// eliminar (desactivar) la cuenta propia. No hay tabla separada --
// todo vive en la tabla `users` que ya usa auth.
// =============================================================
import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { pool } from '../db';

const SALT_ROUNDS = 10;

@Injectable()
export class UsersService {
  async getMe(userId: string) {
    const { rows } = await pool.query(
      `SELECT u.id, u.full_name, u.phone, u.role, u.rating, u.created_at, dp.approval_status
       FROM users u LEFT JOIN driver_profiles dp ON dp.user_id = u.id
       WHERE u.id = $1 AND u.is_active = TRUE`,
      [userId],
    );
    if (rows.length === 0) throw new UnauthorizedException('Usuario no encontrado');
    return rows[0];
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    if (newPassword.length < 6) {
      throw new BadRequestException('La nueva contraseña debe tener al menos 6 caracteres');
    }
    const { rows } = await pool.query(`SELECT password_hash FROM users WHERE id = $1 AND is_active = TRUE`, [
      userId,
    ]);
    if (rows.length === 0) throw new UnauthorizedException('Usuario no encontrado');
    const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!valid) throw new UnauthorizedException('La contraseña actual no es correcta');
    const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await pool.query(`UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, [userId, newHash]);
  }

  // "Eliminar cuenta": desactiva el usuario (is_active = FALSE) en vez
  // de borrar la fila -- así se conserva el historial de viajes
  // (pasado/futuro) para el otro lado (conductor/pasajero) y las
  // estadísticas, pero el login deja de funcionar de inmediato.
  async deactivate(userId: string): Promise<void> {
    await pool.query(`UPDATE users SET is_active = FALSE, updated_at = now() WHERE id = $1`, [userId]);
  }
}
