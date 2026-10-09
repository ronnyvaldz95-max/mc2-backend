// =============================================================
// Convierte una cuenta existente en administradora de MC2.
//   node scripts/make-admin.js 0981123456
// Usá un teléfono que ya esté registrado como PASAJERO (no uno de
// conductor, porque perdería el perfil de conductor). Después de
// correrlo, volvé a iniciar sesión para que el token traiga el rol.
// =============================================================
require('dotenv').config();
const { Pool } = require('pg');

const phone = process.argv[2];
if (!phone) {
  console.error('Uso: node scripts/make-admin.js <telefono>');
  process.exit(1);
}

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

pool
  .query(`UPDATE users SET role = 'admin' WHERE phone = $1 RETURNING id, full_name, role`, [phone])
  .then(async (r) => {
    if (r.rowCount === 0) console.error(`No hay ningún usuario con teléfono ${phone}`);
    else console.log(`Listo: ${r.rows[0].full_name} ahora es admin.`);
    await pool.end();
  })
  .catch(async (err) => {
    console.error('Error:', err.message);
    await pool.end();
    process.exit(1);
  });
