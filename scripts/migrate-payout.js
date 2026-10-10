// Agrega a driver_profiles los datos para que el pasajero le pague
// directo al conductor: alias/cuenta para transferencias y llave Pix.
// Se corre UNA vez:  node scripts/migrate-payout.js
require('dotenv').config();
const { Pool } = require('pg');
const useSsl = process.env.PGSSL === 'true';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: useSsl ? { rejectUnauthorized: false } : undefined });
pool
  .query(`ALTER TABLE driver_profiles
            ADD COLUMN IF NOT EXISTS transfer_alias VARCHAR(120),
            ADD COLUMN IF NOT EXISTS pix_key VARCHAR(120)`)
  .then(() => console.log('Listo. transfer_alias y pix_key creadas.'))
  .catch((e) => { console.error('Error:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
