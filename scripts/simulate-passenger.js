// =============================================================
// Simula a un pasajero pidiendo un viaje: se loguea (POST /auth/login)
// para conseguir un JWT, llama a POST /trips con ese token, se suscribe
// al resultado por WebSocket (trip:subscribe) y muestra qué pasa
// (trip:matched o trip:no_drivers_available).
//
// Uso normal (pasajero de prueba del seed, necesita conectar directo a
// Postgres para buscarlo):
//   npm run simulate:passenger
//
// Uso manual (cuando la red bloquea la conexión directa a la base de
// datos, por ejemplo una red corporativa, o para probar con cualquier
// otro pasajero ya registrado): pasás el teléfono a mano. Si es un
// pasajero registrado por la app (no el del seed), también hay que
// pasar su contraseña con --password.
//   npm run simulate:passenger -- --phone +595981000000
//   npm run simulate:passenger -- --phone +595985550001 --password miContraseña
//
// Para ver el flujo completo, corré esto mientras al menos un conductor
// está "online" (con la app, o con npm run simulate:driver).
// =============================================================
require('dotenv').config();
const { io } = require('socket.io-client');

const args = process.argv.slice(2);
const serverUrl = process.env.MC2_WS_URL || 'http://localhost:3000';
const useSsl = process.env.PGSSL === 'true';

function argValue(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const manualPhone = argValue('phone');
const manualPassword = argValue('password') || process.env.MC2_DEMO_PASSWORD || 'demo1234';

async function getPassenger() {
  // Si se pasa --phone no conectamos nada a Postgres: útil cuando la red
  // bloquea el puerto de la base de datos (por ejemplo redes corporativas).
  if (manualPhone) {
    return { full_name: '(manual)', id: '(manual)', phone: manualPhone, password: manualPassword };
  }

  const { Pool } = require('pg');
  const pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: useSsl ? { rejectUnauthorized: false } : undefined })
    : new Pool({
        host: process.env.PGHOST || 'localhost',
        port: Number(process.env.PGPORT) || 5432,
        user: process.env.PGUSER || 'mc2',
        password: process.env.PGPASSWORD || 'mc2dev',
        database: process.env.PGDATABASE || 'mc2_movilidad',
      });

  const { rows } = await pool.query(`SELECT id, full_name, phone FROM users WHERE role = 'passenger' LIMIT 1`);
  await pool.end();
  if (rows.length === 0) {
    console.error(`No encontré ningún pasajero. ¿Corriste "npm run seed" en el prototipo?`);
    process.exit(1);
  }
  return { ...rows[0], password: process.env.MC2_DEMO_PASSWORD || 'demo1234' };
}

async function main() {
  const passenger = await getPassenger();

  console.log(`Simulando a ${passenger.full_name} (id ${passenger.id})`);
  console.log('Iniciando sesión (POST /auth/login)...');

  const loginRes = await fetch(`${serverUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: passenger.phone, password: passenger.password }),
  });
  if (!loginRes.ok) {
    console.error('No pude loguearme:', loginRes.status, await loginRes.text());
    process.exit(1);
  }
  const { access_token: token } = await loginRes.json();
  console.log('Login OK. Conectando a', serverUrl, '...');

  // Punto de recogida: el mismo centro de Pedro Juan Caballero que usa match.js.
  const pickup = { lat: -22.548, lon: -55.7335 };
  // Destino: un punto cualquiera un par de km al sur, solo para tener algo válido.
  const dropoff = { lat: pickup.lat - 0.02, lon: pickup.lon + 0.015 };

  const socket = io(serverUrl, { transports: ['websocket'] });

  socket.on('connect', async () => {
    console.log('Conectado. Pidiendo un viaje...');

    const res = await fetch(`${serverUrl}/trips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ pickup, dropoff }),
    });

    if (!res.ok) {
      console.error('Error pidiendo el viaje:', res.status, await res.text());
      process.exit(1);
    }

    const { trip_id, status } = await res.json();
    console.log(`Viaje ${trip_id} creado (status: ${status}). Esperando que un conductor acepte...`);
    socket.emit('trip:subscribe', { tripId: trip_id });
  });

  socket.on('trip:matched', (payload) => {
    console.log('\n¡Viaje aceptado!');
    console.log(
      `  Conductor: ${payload.driver.full_name} — ${payload.driver.vehicle_type} (${payload.driver.plate}) — ★${payload.driver.rating}`,
    );
    process.exit(0);
  });

  socket.on('trip:no_drivers_available', () => {
    console.log('\nNingún conductor disponible aceptó el viaje (no_drivers_available).');
    process.exit(0);
  });

  socket.on('connect_error', (err) => console.error('No se pudo conectar:', err.message));

  setTimeout(() => {
    console.error('\nSe agotó el tiempo de espera sin respuesta del servidor.');
    process.exit(1);
  }, 90_000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
