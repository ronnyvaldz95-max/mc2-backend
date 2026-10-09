// Copia de src/phone.ts para los scripts de Node (ver ese archivo).
function normalizePhone(raw) {
  const trimmed = String(raw ?? '').trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';
  if (trimmed.startsWith('+')) return '+' + digits;
  if (digits.startsWith('595')) return '+' + digits;
  if (digits.startsWith('0') && digits.length >= 9) return '+595' + digits.slice(1);
  if (digits.startsWith('9') && digits.length === 9) return '+595' + digits;
  return digits;
}
module.exports = { normalizePhone };
