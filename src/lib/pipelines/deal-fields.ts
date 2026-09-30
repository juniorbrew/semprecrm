// Inline-editable deal fields in the inbox panel ("Campos do negócio").
//
// SempreCRM deals have no per-pipeline custom fields (custom_fields only
// hold *contact* values), so the panel edits the deal's own columns:
// value, expected close date and notes. Pure validation lives here.

export interface DealFieldDraft {
  /** Free text as typed; comma or dot decimals (pt-BR). */
  value: string;
  /** yyyy-mm-dd or empty. */
  expected_close_date: string;
  notes: string;
}

export type DealFieldError = 'value' | 'date' | 'notes';

export interface DealFieldPatch {
  value: number;
  expected_close_date: string | null;
  notes: string | null;
}

export const DEAL_NOTES_MAX = 2000;

export function parseDealValue(raw: string): number | null {
  const s = raw.trim().replace(/\s/g, '');
  if (s === '') return 0;
  // "1.234,56" -> 1234.56 ; "1234.56" stays.
  const norm = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  if (!/^\d+(\.\d{1,2})?$/.test(norm)) return null;
  const n = Number(norm);
  return Number.isFinite(n) && n <= 999_999_999_999 ? n : null;
}

export function validateDealFields(
  draft: DealFieldDraft,
): { ok: true; patch: DealFieldPatch } | { ok: false; errors: DealFieldError[] } {
  const errors: DealFieldError[] = [];
  const value = parseDealValue(draft.value);
  if (value === null) errors.push('value');
  const date = draft.expected_close_date.trim();
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)))) {
    errors.push('date');
  }
  const notes = draft.notes.trim();
  if (notes.length > DEAL_NOTES_MAX) errors.push('notes');
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    patch: { value: value as number, expected_close_date: date || null, notes: notes || null },
  };
}
