// =============================================================
// Simula a la pasajera de prueba (Rosa Melgarejo, la que crea
// seed.js) pidiendo un viaje: llama a POST /trips, se suscribe al
// resultado por WebSocket (trip:subscribe) y muestra qué pasa
// (trip:matched o trip:no_drivers_available).
//
// Uso:
//   npm run simulate:passenger
//
// Para ver el flujo completo, corré esto en una tercera terminal
// mientras "npm run start:dev" y al menos un "npm run simulate:driver"
// están corriendo.
// =============================================================
const { Pool } = require('pg');
const { io } = require('socket.io-client');

const serverUrl = process.env.MC2_WS_URL || 'http://localhost:3000';

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT) || 5432,
  user: process.env.PGUSER || 'mc2',
  password: process.env.PGPASSWORD || 'mc2dev',
  database: process.env.PGDATABASE || 'mc2_movilidad',
});

async function main() {
  const { rows } = await pool.query(`SELECT id, full_name FROM users WHERE role = 'passenger' LIMIT 1`);
  if (rows.length === 0) {
    console.error(`No encontré ningún pasajero. ¿Corriste "npm run seed" en el prototipo?`);
    await pool.end();
    process.exit(1);
  }
  const passenger = rows[0];
  await pool.end();

  console.log(`Simulando a ${passenger.full_name} (id ${passenger.id})`);

  // Punto de recogida: el mismo centro de Pedro Juan Caballero que usa match.js.
  const pickup = { lat: -22.548, lon: -55.7335 };
  // Destino: un punto cualquiera un par de km al sur, solo para tener algo válido.
  const dropoff = { lat: pickup.lat - 0.02, lon: pickup.lon + 0.015 };

  const socket = io(serverUrl, { transports: ['websocket'] });

  socket.on('connect', async () => {
    console.log('Conectado. Pidiendo un viaje...');

    const res = await fetch(`${serverUrl}/trips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passengerId: passenger.id, pickup, dropoff }),
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
