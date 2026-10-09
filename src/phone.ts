// =============================================================
// Normaliza teléfonos paraguayos a un solo formato: +5959XXXXXXXX.
// Así da igual si la persona escribe "0981 123 456", "981123456",
// "595981123456" o "+595 981 123-456": siempre se guarda y se busca
// igual. Números de otro país que vengan con "+" (por ejemplo +55 de
// Brasil) se respetan tal cual, solo sin espacios ni guiones.
// La misma lógica está copiada en scripts/phone.js para los scripts.
// =============================================================
export function normalizePhone(raw: string): string {
  const trimmed = String(raw ?? '').trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';
  if (trimmed.startsWith('+')) return '+' + digits;
  if (digits.startsWith('595')) return '+' + digits;
  if (digits.startsWith('0') && digits.length >= 9) return '+595' + digits.slice(1);
  if (digits.startsWith('9') && digits.length === 9) return '+595' + digits;
  return digits;
}
