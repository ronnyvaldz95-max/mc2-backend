// Cambia el teléfono de una cuenta.
//   node scripts/set-phone.js +595985550001 0981123456
// El número nuevo se guarda normalizado (+5959...). Si ya lo usa otra
// cuenta, no cambia nada y te avisa.
require('dotenv').config();
const { Pool } = require('pg');
const { normalizePhone } = require('./phone');

const [oldRaw, newRaw] = process.argv.slice(2);
if (!oldRaw || !newRaw) {
  console.error('Uso: node scripts/set-phone.js <telefono actual> <telefono nuevo>');
  process.exit(1);
}
// "VACIO" sirve para arreglar una cuenta que quedó sin teléfono.
const oldPhone = oldRaw === 'VACIO' ? '' : normalizePhone(oldRaw);
const newPhone = normalizePhone(newRaw);
if (newPhone.replace(/\D/g, '').length < 8) {
  console.error(`"${newRaw}" no parece un teléfono válido. Escribilo con números, por ejemplo 0981123456.`);
  process.exit(1);
}
const useSsl = process.env.PGSSL === 'true';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: useSsl ? { rejectUnauthorized: false } : undefined });

async function main() {
  const { rows: taken } = await pool.query('SELECT full_name, role FROM users WHERE phone = $1', [newPhone]);
  if (taken[0]) {
    console.error(`El ${newPhone} ya lo usa ${taken[0].full_name} (${taken[0].role}). No cambié nada.`);
    return;
  }
  const r = await pool.query(
    'UPDATE users SET phone = $2, updated_at = now() WHERE phone = $1 RETURNING full_name',
    [oldPhone, newPhone],
  );
  if (r.rowCount === 0) console.error(`No hay ningún usuario con teléfono ${oldPhone}`);
  else console.log(`Listo: ${r.rows[0].full_name} ahora entra con ${newPhone}`);
}

main()
  .catch((e) => { console.error('Error:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
