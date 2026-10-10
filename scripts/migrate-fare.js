// Agrega trips.fare_gs (tarifa del viaje, la calcula el servidor).
// Se corre UNA vez:  node scripts/migrate-fare.js
require('dotenv').config();
const { Pool } = require('pg');
const useSsl = process.env.PGSSL === 'true';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: useSsl ? { rejectUnauthorized: false } : undefined });
pool
  .query('ALTER TABLE trips ADD COLUMN IF NOT EXISTS fare_gs INTEGER')
  .then(() => console.log('Listo. trips.fare_gs creada.'))
  .catch((e) => { console.error('Error:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
