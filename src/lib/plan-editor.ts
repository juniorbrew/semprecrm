export function parseBrazilianPrice(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+(?:[,.]\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split(/[,.]/);
  const cents = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, '0'));
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}
export function parseCapacity(raw: string): number | null {
  return /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))
    ? Number(raw)
    : null;
}
export function formatPlanPrice(cents: number | null): string {
  return cents === null
    ? 'Sob consulta'
    : new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL',
      }).format(cents / 100);
}
