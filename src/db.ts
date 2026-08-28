// Conexión compartida a Postgres y Redis, usada por todo el backend.
//
// Postgres: si hay DATABASE_URL (por ejemplo, la connection string que
// te da Supabase), se usa esa. Si no, arma la conexión con las variables
// sueltas (PGHOST, PGPORT, etc.) — así sigue funcionando igual con el
// Postgres local de Docker sin tener que cambiar nada.
// PGSSL=true activa SSL (Supabase lo exige; Postgres local en Docker no).
//
// Redis: igual que Postgres -- si hay REDIS_URL (la que te da Upstash,
// con esquema rediss:// que activa TLS solo) se usa esa. Si no, arma la
// conexión con REDIS_HOST/REDIS_PORT sueltos (el Redis local de Docker).
import { Pool } from 'pg';
import Redis from 'ioredis';

const useSsl = process.env.PGSSL === 'true';

export const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    })
  : new Pool({
      host: process.env.PGHOST || 'localhost',
      port: Number(process.env.PGPORT) || 5432,
      user: process.env.PGUSER || 'mc2',
      password: process.env.PGPASSWORD || 'mc2dev',
      database: process.env.PGDATABASE || 'mc2_movilidad',
      ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    });

export const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT) || 6379,
    });

// Nombre del set geoespacial en Redis donde viven los conductores
// "online" ahora mismo. Cada conductor se agrega/actualiza con
// GEOADD cada vez que su app manda un ping de ubicación.
export const DRIVERS_GEO_KEY = 'drivers:online';
