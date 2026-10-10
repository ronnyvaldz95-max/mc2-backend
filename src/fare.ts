// =============================================================
// Tarifa del viaje, calculada en el SERVIDOR (fuente de verdad). Es
// la misma fórmula que muestra la app del pasajero
// (mc2_app/lib/utils/fare_calculator.dart) -- si cambiás los números
// acá, cambialos allá también.
//
// Gs. 21.000 de piso (cubre ~3 km / 8 min) + Gs. 2.000 por km extra
// + Gs. 300 por minuto extra, redondeado a Gs. 500.
// Sin destino informado no hay tarifa: se cobra según lo que acuerden.
// =============================================================
export const BASE_FARE_GS = 21_000;
const AVG_SPEED_KMH = 22;
const INCLUDED_KM = 3;
const INCLUDED_MIN = 8;
const PER_KM_EXTRA_GS = 2_000;
const PER_MIN_EXTRA_GS = 300;

export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function estimateFareGs(pickup: { lat: number; lon: number }, dropoff: { lat: number; lon: number } | null): number | null {
  if (!dropoff) return null;
  const km = distanceKm(pickup, dropoff);
  const minutes = (km / AVG_SPEED_KMH) * 60;
  const raw =
    BASE_FARE_GS +
    Math.max(0, km - INCLUDED_KM) * PER_KM_EXTRA_GS +
    Math.max(0, minutes - INCLUDED_MIN) * PER_MIN_EXTRA_GS;
  return Math.round(raw / 500) * 500;
}
