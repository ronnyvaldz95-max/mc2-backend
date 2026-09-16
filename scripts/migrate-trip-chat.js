// =============================================================
// Crea la tabla trip_messages (chat entre pasajero y conductor
// durante un viaje). Se ejecuta UNA vez a mano:
//   node scripts/migrate-trip-chat.js
// Usa la misma DATABASE_URL (u otras variables PG*) que ya tenés
// en .env, igual que el resto del backend -- no rompe nada de lo
// que ya existe (CREATE TABLE IF NOT EXISTS).
// =============================================================
require('dotenv').config();
const { Pool } = require('pg');

const useSsl = process.env.PGSSL === 'true';
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: useSsl ? { rejectUnauthorized: false } : undefined })
  : new Pool({
      host: process.env.PGHOST || 'localhost',
      port: Number(process.env.PGPORT) || 5432,
      user: process.env.PGUSER || 'mc2',
      password: process.env.PGPASSWORD || 'mc2dev',
      database: process.env.PGDATABASE || 'mc2_movilidad',
      ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    });

const SQL = `
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS trip_messages (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_id     UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    sender_id   UUID NOT NULL REFERENCES users(id),
    sender_role VARCHAR(20) NOT NULL CHECK (sender_role IN ('passenger', 'driver')),
    text        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trip_messages_trip ON trip_messages (trip_id, created_at);
`;

async function main() {
  console.log('Creando tabla trip_messages (si no existe)...');
  await pool.query(SQL);
  console.log('Listo. Tabla trip_messages lista para usar.');
  await pool.end();
}

main().catch((err) => {
  console.error('Error aplicando la migración:', err.message);
  process.exit(1);
});
