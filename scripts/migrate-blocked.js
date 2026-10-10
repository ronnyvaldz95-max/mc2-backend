// Agrega a users:
//   - blocked          (bloqueado desde el panel)
//   - document_number  (número de cédula, obligatorio al registrarse)
// Se corre UNA vez:  node scripts/migrate-blocked.js
require('dotenv').config();
const { Pool } = require('pg');
const useSsl = process.env.PGSSL === 'true';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: useSsl ? { rejectUnauthorized: false } : undefined });
pool
  .query(`ALTER TABLE users
            ADD COLUMN IF NOT EXISTS blocked BOOLEAN NOT NULL DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS document_number VARCHAR(20)`)
  .then(() => console.log('Listo. users.blocked y users.document_number creadas.'))
  .catch((e) => { console.error('Error:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
