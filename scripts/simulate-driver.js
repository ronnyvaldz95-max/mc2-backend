// =============================================================
// Simula a UN conductor: se loguea (POST /auth/login) para conseguir
// un JWT real, manda pings de posición por WebSocket, y recibe y
// responde ofertas de viaje (trip:offer), aceptando automáticamente
// después de una demora corta simulando que "el conductor mira el
// celular y toca aceptar".
//
// Uso:
//   npm run simulate:driver -- "PJC 001"
//   npm run simulate:driver -- "PJC 001" --reject   (para probar el
//                                                     fallback al siguiente candidato)
//
// Busca el driver por patente (los datos los crea `npm run seed` en
// el prototipo, con la contraseña demo compartida "demo1234").
// Ctrl+C para cortar (manda driver:offline antes de salir).
// =============================================================
require('dotenv').config();
const { Pool } = require('pg');
const { io } = require('socket.io-client');

const args = process.argv.slice(2);
const plate = args.find((a) => !a.startsWith('--')) || 'PJC 001';
const alwaysReject = args.includes('--reject');
const serverUrl = process.env.MC2_WS_URL || 'http://localhost:3000';
const DEMO_PASSWORD = process.env.MC2_DEMO_PASSWORD || 'demo1234';
const useSsl = process.env.PGSSL === 'true';

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: useSsl ? { rejectUnauthorized: false } : undefined })
  : new Pool({
      host: process.env.PGHOST || 'localhost',
      port: Number(process.env.PGPORT) || 5432,
      user: process.env.PGUSER || 'mc2',
      password: process.env.PGPASSWORD || 'mc2dev',
      database: process.env.PGDATABASE || 'mc2_movilidad',
    });

function jitter(value, magnitude = 0.0006) {
  return value + (Math.random() - 0.5) * magnitude;
}

async function main() {
  const { rows } = await pool.query(
    `SELECT dp.user_id, u.full_name, u.phone,
            ST_Y(dp.last_location::geometry) AS lat,
            ST_X(dp.last_location::geometry) AS lon
     FROM driver_profiles dp
     JOIN users u ON u.id = dp.user_id
     JOIN vehicles v ON v.id = dp.active_vehicle_id
     WHERE v.plate = $1`,
    [plate],
  );

  if (rows.length === 0) {
    console.error(`No encontré ningún conductor con patente "${plate}". ¿Corriste "npm run seed" en el prototipo?`);
    await pool.end();
    process.exit(1);
  }

  const driver = rows[0];
  let lat = Number(driver.lat);
  let lon = Number(driver.lon);
  await pool.end();

  console.log(`Simulando a ${driver.full_name} (${plate}, id ${driver.user_id})`);
  console.log('Iniciando sesión (POST /auth/login)...');

  const loginRes = await fetch(`${serverUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: driver.phone, password: DEMO_PASSWORD }),
  });
  if (!loginRes.ok) {
    console.error('No pude loguearme:', loginRes.status, await loginRes.text());
    process.exit(1);
  }
  const { access_token: token } = await loginRes.json();
  console.log('Login OK. Conectando a', serverUrl, '...');

  const socket = io(serverUrl, { transports: ['websocket'] });

  socket.on('connect', () => {
    console.log('Conectado. Mandando driver:online...');
    socket.emit('driver:online', { token, lat, lon });
  });

  let pingTimer;
  socket.on('driver:online:ack', () => {
    console.log('Confirmado online. Mandando un ping cada 4s (Ctrl+C para cortar)...');
    pingTimer = setInterval(() => {
      lat = jitter(lat);
      lon = jitter(lon);
      socket.emit('driver:ping', { lat, lon });
      console.log(`  ping -> (${lat.toFixed(6)}, ${lon.toFixed(6)})`);
    }, 4000);
  });

  socket.on('trip:offer', (offer) => {
    const decision = alwaysReject ? 'RECHAZAR' : 'ACEPTAR';
    const delayMs = 1000 + Math.random() * 2000;
    console.log(
      `\n>> Oferta de viaje ${offer.tripId} (pickup ${offer.pickup.lat},${offer.pickup.lon}). ` +
        `Voy a ${decision} en ${Math.round(delayMs / 100) / 10}s...`,
    );
    setTimeout(() => {
      socket.emit('trip:respond', { tripId: offer.tripId, accept: !alwaysReject });
      console.log(`>> Respondí ${decision} al viaje ${offer.tripId}\n`);
    }, delayMs);
  });

  socket.on('driver:error', (err) => console.error('Error del servidor:', err));
  socket.on('connect_error', (err) => console.error('No se pudo conectar:', err.message));

  const shutdown = () => {
    console.log('\nCortando... mandando driver:offline');
    clearInterval(pingTimer);
    socket.emit('driver:offline');
    setTimeout(() => {
      socket.disconnect();
      process.exit(0);
    }, 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
