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

export type DealFieldKey = keyof DealFieldDraft;
export type DealFieldError = 'value' | 'value-max' | 'date' | 'notes';

/** Only the fields that were edited; unedited ones are never sent. */
export interface DealFieldPatch {
  value?: number;
  expected_close_date?: string | null;
  notes?: string | null;
}

export const DEAL_NOTES_MAX = 2000;
/** deals.value is NUMERIC(12,2). */
export const DEAL_VALUE_MAX = 9_999_999_999.99;

/** number, `null` when malformed, `'overflow'` when above NUMERIC(12,2). */
export function parseDealValue(raw: string): number | null | 'overflow' {
  const s = raw.trim().replace(/\s/g, '');
  if (s === '') return 0;
  // "1.234,56" -> 1234.56 ; "1234.56" stays.
  const norm = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  if (!/^\d+(\.\d{1,2})?$/.test(norm)) return null;
  const n = Number(norm);
  if (!Number.isFinite(n) || n > DEAL_VALUE_MAX) return 'overflow';
  return n;
}

/**
 * Validates the edited fields (`dirty` omitted = all of them) and builds
 * a patch with just those. Notes length is only checked when notes were
 * edited, so an already-long legacy note never blocks saving the value.
 */
export function validateDealFields(
  draft: DealFieldDraft,
  dirty?: Partial<Record<DealFieldKey, boolean>>,
): { ok: true; patch: DealFieldPatch } | { ok: false; errors: DealFieldError[] } {
  const is = (k: DealFieldKey) => (dirty ? !!dirty[k] : true);
  const errors: DealFieldError[] = [];
  const patch: DealFieldPatch = {};

  if (is('value')) {
    const value = parseDealValue(draft.value);
    if (value === null) errors.push('value');
    else if (value === 'overflow') errors.push('value-max');
    else patch.value = value;
  }
  if (is('expected_close_date')) {
    const date = draft.expected_close_date.trim();
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)))) {
      errors.push('date');
    } else {
      patch.expected_close_date = date || null;
    }
  }
  if (is('notes')) {
    const notes = draft.notes.trim();
    if (notes.length > DEAL_NOTES_MAX) errors.push('notes');
    else patch.notes = notes || null;
  }
  return errors.length ? { ok: false, errors } : { ok: true, patch };
}
