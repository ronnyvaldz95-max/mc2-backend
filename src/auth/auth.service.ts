// =============================================================
// Registro y login. Passwords se guardan con bcrypt (nunca en
// texto plano), y el login devuelve un JWT que el cliente manda
// en el header "Authorization: Bearer <token>" en cada pedido
// protegido (por ejemplo, POST /trips), y en el payload al
// conectarse por WebSocket como conductor (driver:online).
// =============================================================
import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { pool } from '../db';

const SALT_ROUNDS = 10;

export interface RegisterPassengerInput {
  fullName: string;
  phone: string;
  password: string;
}

export interface RegisterDriverInput {
  fullName: string;
  phone: string;
  password: string;
  licenseNumber: string;
  vehicle: {
    plate: string;
    brand?: string;
    model?: string;
    color?: string;
    vehicleType: 'moto' | 'sedan' | 'suv';
  };
}

interface SignableUser {
  id: string;
  full_name: string;
  role: string;
}

@Injectable()
export class AuthService {
  constructor(private readonly jwtService: JwtService) {}

  private signToken(user: SignableUser) {
    return this.jwtService.sign({ sub: user.id, role: user.role, name: user.full_name });
  }

  private authResponse(user: SignableUser) {
    return {
      access_token: this.signToken(user),
      user: { id: user.id, full_name: user.full_name, role: user.role },
    };
  }

  async registerPassenger(input: RegisterPassengerInput) {
    if (!input?.fullName || !input?.phone || !input?.password) {
      throw new BadRequestException('fullName, phone y password son requeridos');
    }
    if (input.password.length < 6) {
      throw new BadRequestException('La contraseña debe tener al menos 6 caracteres');
    }
    const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);
    try {
      const { rows } = await pool.query(
        `INSERT INTO users (full_name, phone, password_hash, role)
         VALUES ($1, $2, $3, 'passenger')
         RETURNING id, full_name, role`,
        [input.fullName, input.phone, passwordHash],
      );
      return this.authResponse(rows[0]);
    } catch (err: any) {
      if (err.code === '23505') throw new ConflictException('Ese teléfono ya está registrado');
      throw err;
    }
  }

  async registerDriver(input: RegisterDriverInput) {
    if (
      !input?.fullName ||
      !input?.phone ||
      !input?.password ||
      !input?.licenseNumber ||
      !input?.vehicle?.plate ||
      !input?.vehicle?.vehicleType
    ) {
      throw new BadRequestException(
        'fullName, phone, password, licenseNumber y vehicle {plate, vehicleType} son requeridos',
      );
    }
    if (input.password.length < 6) {
      throw new BadRequestException('La contraseña debe tener al menos 6 caracteres');
    }
    const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: userRows } = await client.query(
        `INSERT INTO users (full_name, phone, password_hash, role)
         VALUES ($1, $2, $3, 'driver')
         RETURNING id, full_name, role`,
        [input.fullName, input.phone, passwordHash],
      );
      const user = userRows[0];

      const { rows: vehicleRows } = await client.query(
        `INSERT INTO vehicles (driver_id, plate, brand, model, color, vehicle_type)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          user.id,
          input.vehicle.plate,
          input.vehicle.brand || null,
          input.vehicle.model || null,
          input.vehicle.color || null,
          input.vehicle.vehicleType,
        ],
      );
      const vehicleId = vehicleRows[0].id;

      await client.query(
        `INSERT INTO driver_profiles (user_id, license_number, verified, status, active_vehicle_id)
         VALUES ($1, $2, FALSE, 'offline', $3)`,
        [user.id, input.licenseNumber, vehicleId],
      );

      await client.query('COMMIT');
      return this.authResponse(user);
    } catch (err: any) {
      await client.query('ROLLBACK');
      if (err.code === '23505') throw new ConflictException('Ese teléfono o esa patente ya están registrados');
      throw err;
    } finally {
      client.release();
    }
  }

  async login(phone: string, password: string) {
    if (!phone || !password) throw new BadRequestException('phone y password son requeridos');
    const { rows } = await pool.query(`SELECT id, full_name, role, password_hash FROM users WHERE phone = $1`, [
      phone,
    ]);
    const user = rows[0];
    if (!user) throw new UnauthorizedException('Teléfono o contraseña incorrectos');
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) throw new UnauthorizedException('Teléfono o contraseña incorrectos');
    return this.authResponse(user);
  }
}
