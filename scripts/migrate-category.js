// Agrega trips.vehicle_category ('auto' | 'moto'): el pasajero elige
// con qué quiere viajar. Se corre UNA vez:  node scripts/migrate-category.js
require('dotenv').config();
const { Pool } = require('pg');
const useSsl = process.env.PGSSL === 'true';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: useSsl ? { rejectUnauthorized: false } : undefined });
pool
  .query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS vehicle_category VARCHAR(10) NOT NULL DEFAULT 'auto'`)
  .then(() => console.log('Listo. trips.vehicle_category creada.'))
  .catch((e) => { console.error('Error:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
