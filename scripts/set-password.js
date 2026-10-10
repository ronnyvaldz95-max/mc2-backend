// Cambia la contraseña de un usuario (por si te la olvidaste).
//   node scripts/set-password.js +595985550001 NuevaClave123
require('dotenv').config();
const { Pool } = require('pg');
const { normalizePhone } = require('./phone');
if (normalizePhone(process.argv[2] || '').replace(/\D/g, '').length < 8) {
  console.error(`"${process.argv[2] || ''}" no parece un teléfono válido. Escribilo con números, por ejemplo 0981123456.`);
  process.exit(1);
}
const bcrypt = require('bcryptjs');

const [phone, password] = process.argv.slice(2);
if (!phone || !password || password.length < 6) {
  console.error('Uso: node scripts/set-password.js <telefono> <contraseña de 6+ caracteres>');
  process.exit(1);
}
const useSsl = process.env.PGSSL === 'true';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: useSsl ? { rejectUnauthorized: false } : undefined });

bcrypt
  .hash(password, 10)
  .then((hash) => pool.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE phone = $1 RETURNING full_name', [normalizePhone(phone), hash]))
  .then(async (r) => {
    if (r.rowCount === 0) console.error(`No hay ningún usuario con teléfono ${phone}`);
    else console.log(`Listo: contraseña de ${r.rows[0].full_name} actualizada.`);
    await pool.end();
  })
  .catch(async (e) => { console.error('Error:', e.message); await pool.end(); process.exit(1); });
