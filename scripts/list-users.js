// Lista los usuarios (nombre, teléfono, rol) para encontrar tu número.
//   node scripts/list-users.js
require('dotenv').config();
const { Pool } = require('pg');
const useSsl = process.env.PGSSL === 'true';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: useSsl ? { rejectUnauthorized: false } : undefined });
pool
  .query('SELECT full_name, phone, role FROM users WHERE is_active = TRUE ORDER BY role, created_at')
  .then((r) => { console.table(r.rows); return pool.end(); })
  .catch(async (e) => { console.error('Error:', e.message); await pool.end(); process.exit(1); });
