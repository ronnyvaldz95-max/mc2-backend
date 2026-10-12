// =============================================================
// Tarifas y comisión de MC2, calculadas en el SERVIDOR (fuente de
// verdad). Se configuran con variables de entorno en Render, así se
// pueden ajustar en cualquier momento SIN reinstalar la app (la app
// pide estos mismos valores a GET /pricing para mostrar el estimado).
//
//   FARE_BASE_GS         tarifa base (cubre los km/min incluidos)
//   FARE_INCLUDED_KM     km incluidos en la base
//   FARE_INCLUDED_MIN    minutos incluidos en la base
//   FARE_PER_KM_GS       por cada km extra
//   FARE_PER_MIN_GS      por cada minuto extra
//   FARE_AVG_SPEED_KMH   velocidad promedio para estimar minutos
//   FARE_ROUTE_FACTOR    multiplica la distancia en línea recta para
//                        acercarla a la distancia real por calles
//   FARE_ROUND_GS        redondeo del precio final
//   MOTO_FARE_PERCENT    precio de la moto como % del de auto (70 = 30% más barato)
//   COMMISSION_PERCENT   % de cada viaje que se queda MC2
//   COMMISSION_MIN_GS    comisión mínima por viaje
// =============================================================
const num = (name: string, def: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== '' && process.env[name] != null ? v : def;
};

export function getPricing() {
  return {
    base_gs: num('FARE_BASE_GS', 18_000),
    included_km: num('FARE_INCLUDED_KM', 3),
    included_min: num('FARE_INCLUDED_MIN', 8),
    per_km_gs: num('FARE_PER_KM_GS', 2_000),
    per_min_gs: num('FARE_PER_MIN_GS', 300),
    avg_speed_kmh: num('FARE_AVG_SPEED_KMH', 22),
    route_factor: num('FARE_ROUTE_FACTOR', 1),
    round_gs: num('FARE_ROUND_GS', 500),
    moto_percent: num('MOTO_FARE_PERCENT', 70),
    commission_percent: num('COMMISSION_PERCENT', 10),
    commission_min_gs: num('COMMISSION_MIN_GS', 3_000),
  };
}

export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export type VehicleCategory = 'auto' | 'moto';

export function estimateFareGs(
  pickup: { lat: number; lon: number },
  dropoff: { lat: number; lon: number } | null,
  category: VehicleCategory = 'auto',
): number | null {
  if (!dropoff) return null;
  const p = getPricing();
  return fareForKm(distanceKm(pickup, dropoff) * p.route_factor, category);
}

// Precio para una distancia ya conocida (km por calle). Lo usa el
// estimado con destino y también el cierre de un viaje SIN destino,
// donde los km salen del recorrido real del conductor.
export function fareForKm(km: number, category: VehicleCategory = 'auto'): number {
  const p = getPricing();
  const minutes = (km / p.avg_speed_kmh) * 60;
  const carRaw =
    p.base_gs +
    Math.max(0, km - p.included_km) * p.per_km_gs +
    Math.max(0, minutes - p.included_min) * p.per_min_gs;
  const raw = category === 'moto' ? (carRaw * p.moto_percent) / 100 : carRaw;
  const step = p.round_gs > 0 ? p.round_gs : 1;
  return Math.round(raw / step) * step;
}

// Comisión de MC2: % del viaje con un mínimo. Sin tarifa (viaje sin
// destino informado) se cobra el mínimo.
export function commissionFor(fareGs: number | null): number {
  const p = getPricing();
  if (fareGs == null) return p.commission_min_gs;
  const pct = Math.round((fareGs * p.commission_percent) / 100 / 50) * 50; // redondeo a Gs. 50
  return Math.max(p.commission_min_gs, pct);
}

// Lo que sigue estaba antes como constante; se mantiene el nombre por
// compatibilidad con imports existentes.
export const BASE_FARE_GS = 18_000;
