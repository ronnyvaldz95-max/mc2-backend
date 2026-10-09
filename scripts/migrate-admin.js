// =============================================================
// Migración del panel de administración de MC2. Se corre UNA vez:
//   node scripts/migrate-admin.js
//
// 1. driver_profiles.approval_status: 'pending' | 'approved' |
//    'suspended' | 'rejected'. Solo 'approved' puede ponerse online
//    y recibir viajes. Los conductores que YA existen quedan
//    'approved' (para no romper tus pruebas); los nuevos entran
//    'pending' hasta que los apruebes desde el panel.
// 2. trips.commission_amount / commission_paid_at: cada viaje
//    completado le debe Gs. 3.000 a MC2 hasta que lo marques pagado.
// 3. Permite el rol 'admin' en users y el estado
//    'cancelled_by_admin' en trips (si había CHECK o ENUM).
//
// Es seguro correrlo más de una vez.
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

// Agrega `value` a los valores permitidos de table.column, sea que la
// columna use un ENUM de Postgres o un CHECK (col IN (...)).
async function allowValue(table, column, value) {
  const { rows: cols } = await pool.query(
    `SELECT data_type, udt_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  if (cols.length === 0) throw new Error(`No existe ${table}.${column}`);

  if (cols[0].data_type === 'USER-DEFINED') {
    await pool.query(`ALTER TYPE ${cols[0].udt_name} ADD VALUE IF NOT EXISTS '${value}'`);
    console.log(`  ${table}.${column}: ENUM ${cols[0].udt_name} acepta '${value}'`);
    return;
  }

  const { rows: checks } = await pool.query(
    `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE contype = 'c' AND conrelid = $1::regclass`,
    [table],
  );
  const check = checks.find((c) => new RegExp(`\\b${column}\\b`).test(c.def) && /'[^']+'/.test(c.def));
  if (!check) {
    console.log(`  ${table}.${column}: sin restricción, nada que hacer`);
    return;
  }
  const values = [...check.def.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (values.includes(value)) {
    console.log(`  ${table}.${column}: ya acepta '${value}'`);
    return;
  }
  values.push(value);
  const list = values.map((v) => `'${v}'`).join(', ');
  await pool.query(`ALTER TABLE ${table} DROP CONSTRAINT ${check.conname}`);
  await pool.query(`ALTER TABLE ${table} ADD CONSTRAINT ${check.conname} CHECK (${column} IN (${list}))`);
  console.log(`  ${table}.${column}: CHECK actualizado -> ${list}`);
}

async function main() {
  console.log('1) Estado de aprobación de conductores...');
  const { rows: existing } = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'driver_profiles' AND column_name = 'approval_status'`,
  );
  await pool.query(`
    ALTER TABLE driver_profiles
      ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) NOT NULL DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS approval_notes  TEXT,
      ADD COLUMN IF NOT EXISTS approved_at     TIMESTAMPTZ
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE driver_profiles ADD CONSTRAINT driver_profiles_approval_status_check
        CHECK (approval_status IN ('pending', 'approved', 'suspended', 'rejected'));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$
  `);
  if (existing.length === 0) {
    const r = await pool.query(
      `UPDATE driver_profiles SET approval_status = 'approved', approved_at = now()`,
    );
    console.log(`  ${r.rowCount} conductor(es) existentes marcados como aprobados`);
  }

  console.log('2) Comisiones por viaje...');
  await pool.query(`
    ALTER TABLE trips
      ADD COLUMN IF NOT EXISTS commission_amount  INTEGER NOT NULL DEFAULT 3000,
      ADD COLUMN IF NOT EXISTS commission_paid_at TIMESTAMPTZ
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_trips_commission_unpaid
     ON trips (driver_id) WHERE status = 'completed' AND commission_paid_at IS NULL`,
  );

  console.log('3) Rol admin y cancelación por admin...');
  await allowValue('users', 'role', 'admin');
  await allowValue('trips', 'status', 'cancelled_by_admin');

  console.log('Listo.');
  await pool.end();
}

main().catch(async (err) => {
  console.error('Error aplicando la migración:', err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
