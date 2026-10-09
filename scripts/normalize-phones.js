// =============================================================
// Pasa todos los teléfonos guardados al formato único +5959XXXXXXXX
// (ver src/phone.ts). Se corre UNA vez:
//   node scripts/normalize-phones.js
// Si dos cuentas quedarían con el mismo número (por ejemplo
// "0981123456" y "+595981123456"), no toca ninguna de las dos y te
// las muestra para que decidas.
// =============================================================
require('dotenv').config();
const { Pool } = require('pg');
const { normalizePhone } = require('./phone');

const useSsl = process.env.PGSSL === 'true';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: useSsl ? { rejectUnauthorized: false } : undefined });

async function main() {
  const { rows } = await pool.query('SELECT id, full_name, phone, role FROM users');
  const taken = new Map(rows.map((u) => [u.phone, u]));
  let changed = 0;
  const conflicts = [];
  for (const u of rows) {
    const norm = normalizePhone(u.phone);
    if (!norm || norm === u.phone) continue;
    const other = taken.get(norm);
    if (other && other.id !== u.id) {
      conflicts.push(`${u.full_name} (${u.phone}, ${u.role}) choca con ${other.full_name} (${other.phone}, ${other.role})`);
      continue;
    }
    await pool.query('UPDATE users SET phone = $2, updated_at = now() WHERE id = $1', [u.id, norm]);
    taken.delete(u.phone);
    taken.set(norm, u);
    console.log(`  ${u.full_name}: ${u.phone} -> ${norm}`);
    changed++;
  }
  console.log(`Listo. ${changed} teléfono(s) actualizados.`);
  if (conflicts.length) {
    console.log('Sin tocar (mismo número en dos cuentas):');
    conflicts.forEach((c) => console.log('  ' + c));
  }
  await pool.end();
}

main().catch(async (e) => { console.error('Error:', e.message); await pool.end(); process.exit(1); });
