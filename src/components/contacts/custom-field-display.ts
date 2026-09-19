// Display helpers for custom-field values (contact drawer, inbox panel).
//
// Custom fields are free text today (`field_type` = 'text'), but people
// store dates in them ("Data de nascimento" → "1991-03-14"). An ISO date
// is shown in the reader's locale (14/03/1991 in pt-BR, 3/14/1991 in
// en-US) while the stored value stays ISO so sorting/exports keep working.

import type { Language } from '@/lib/i18n';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a bare ISO calendar date ("1991-03-14"). */
export function isIsoDate(value: string | null | undefined): boolean {
  if (!value || !ISO_DATE_RE.test(value.trim())) return false;
  const [y, m, d] = value.trim().split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return (
    date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d
  );
}

/**
 * What to show for a stored custom-field value: an ISO date becomes a
 * locale date (`Intl.DateTimeFormat`, so pt-BR gets dd/mm/yyyy); anything
 * else is returned as is.
 */
export function formatCustomFieldValue(value: string, language: Language): string {
  const trimmed = value.trim();
  if (!isIsoDate(trimmed)) return value;
  const [y, m, d] = trimmed.split('-').map(Number);
  return new Intl.DateTimeFormat(language, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(y, m - 1, d));
}
