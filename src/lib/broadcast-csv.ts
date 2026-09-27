/**
 * CSV → broadcast audience (wacrm #512, upstream 7724c83).
 *
 * The broadcast wizard's "Importar CSV" audience type needs a
 * `{ phone, name }[]` list, a narrower shape than the contacts
 * importer's. Rather than re-parse, this reuses the shared
 * `parseContactCsv` + `dedupeByPhone`, so a CSV that imports cleanly on
 * the Contacts page also broadcasts cleanly.
 *
 * De-duplication happens HERE, on the normalized number, because the
 * downstream contact upsert inserts against the UNIQUE index on
 * (account_id, phone_normalized) (migration 022). Two spellings of the
 * same number in one file ("+55 11 99999-0000" and "5511999990000")
 * would otherwise reach that index as separate inserts and fail the
 * whole broadcast with a 23505.
 *
 * Pure and unit-tested: vitest runs `environment: "node"`, so the logic
 * lives outside the (client) component.
 */

import { dedupeByPhone } from '@/lib/contacts/dedupe';
import { parseContactCsv } from '@/lib/contacts/parse-contact-csv';

/** The shape the wizard hands to `createAndSendBroadcast`. */
export interface BroadcastCsvContact {
  phone: string;
  name?: string;
}

export type BroadcastCsvError =
  /** No `phone` header — the one column we can't work without. */
  | 'missing_phone_column'
  /** Header was fine, but not one row carried a usable number. */
  | 'no_valid_rows';

export type ParseBroadcastCsvResult =
  | {
      ok: true;
      contacts: BroadcastCsvContact[];
      /** Rows dropped as same-number repeats. */
      duplicates: number;
      /** Rows dropped for having no usable phone number. */
      invalid: number;
    }
  | { ok: false; error: BroadcastCsvError };

export function parseBroadcastCsv(text: string): ParseBroadcastCsvResult {
  const { rows, hasPhoneColumn } = parseContactCsv(text);

  if (!hasPhoneColumn) return { ok: false, error: 'missing_phone_column' };

  const { unique, duplicates, invalid } = dedupeByPhone(rows);
  if (unique.length === 0) return { ok: false, error: 'no_valid_rows' };

  return {
    ok: true,
    // Drop email/company/tags: the broadcast audience only addresses
    // people, and `name` is the sole field template variables can map.
    contacts: unique.map(({ phone, name }) => (name ? { phone, name } : { phone })),
    duplicates,
    invalid,
  };
}
