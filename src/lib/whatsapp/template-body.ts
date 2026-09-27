// ============================================================
// Template body resolution — the local `message_templates` row for a
// send, and the substituted body text we persist alongside it.
//
// Every path that sends a template needs the same two things:
//
//   1. the row (for the send-builder's header/button components), and
//   2. the rendered body, so `messages.content_text` carries the text
//      the customer actually received rather than NULL (issue #483).
//
// Both used to be done ad hoc per caller — the dashboard composer
// rendered the body client-side and posted it as `content_text`, while
// the automation engine stored nothing, so its sends landed in the
// Inbox as empty bubbles. Ported from wacrm #483; SempreCRM callers:
// /api/whatsapp/send, automations/meta-send and broadcast-core (which
// only needs the row — campaigns don't write `messages`).
//
// Note: this renderer leaves an unfilled `{{n}}` visible (display
// only). The QR channel's customer-facing renderer in qr-engine-send
// blanks it instead, on purpose.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { isMessageTemplate, isStubTemplate } from '@/lib/whatsapp/template-row-guard';
import type { MessageTemplate } from '@/types';

/**
 * Substitute positional `{{1}}`, `{{2}}`… placeholders in a template
 * body. A placeholder with no corresponding param is left as-is rather
 * than blanked, so a caller that under-supplies params gets a visible
 * `{{2}}` instead of a silently truncated sentence.
 */
export function renderTemplateBody(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, raw) => {
    const idx = Number(raw) - 1;
    return params[idx] ?? `{{${raw}}}`;
  });
}

/**
 * Positional body values out of either param shape a caller may send:
 * the structured `{ body: [...] }` object the composer posts, or the
 * legacy flat array. Structured wins — `sendTemplateMessage` merges
 * them the same way, so what we render matches what Meta is sent.
 */
export function templateBodyParams(
  templateParams?: string[] | null,
  templateMessageParams?: unknown
): string[] {
  const structured =
    templateMessageParams &&
    typeof templateMessageParams === 'object' &&
    Array.isArray((templateMessageParams as { body?: unknown }).body)
      ? ((templateMessageParams as { body: unknown[] }).body.filter(
          (v): v is string => typeof v === 'string'
        ) as string[])
      : null;

  if (structured && structured.length > 0) return structured;
  return Array.isArray(templateParams) ? templateParams : [];
}

/** `en_US` → `en`; used to match a request against a synced row. */
function baseLanguage(language: string): string {
  return language.toLowerCase().split(/[_-]/)[0];
}

/** True for a bare language code (`en`), false for a regional one (`en_US`). */
function isBareLanguage(language: string): boolean {
  return !/[_-]/.test(language);
}

/**
 * Same language, allowing only the bare ↔ regional split (`en` ↔
 * `en_US`). Sibling regions (`pt_PT` for `pt_BR`, `en_GB` for `en_US`)
 * are different translations on Meta's side with their own components,
 * so they never stand in for each other.
 */
function sameLanguageFallback(a: string, b: string): boolean {
  return (
    baseLanguage(a) === baseLanguage(b) && (isBareLanguage(a) || isBareLanguage(b))
  );
}

export interface ResolvedTemplate {
  /** Best-matching local row, or null when the account has none. */
  row: MessageTemplate | null;
  /**
   * True when a row matched by name but failed the shape guard. Callers
   * surface their own error type — a malformed row would otherwise
   * crash deep inside the send-builder with an opaque TypeError.
   */
  malformed: boolean;
  /**
   * The language code to send to Meta: always the matched row's (its
   * components are the ones the send-builder uses), otherwise the
   * caller's, otherwise `en_US`. Callers that pinned `en_US`
   * unconditionally could not send an `en` template at all — Meta
   * rejects the pair as a missing translation.
   */
  language: string;
  /**
   * The matching row is a webhook stub (migration 053) — created from a
   * status event for a template made directly in Meta, with no body or
   * components yet. Senders refuse it until "Sync from Meta" replaces it.
   */
  needsSync: boolean;
}

/**
 * Look up the `message_templates` row for a send, tolerant of the
 * `en` / `en_US` split (never of sibling regions like pt_PT ↔ pt_BR).
 *
 * The old lookup was `.eq('language', requested || 'en_US')`. Templates
 * synced from Meta commonly carry the bare `en`, so a caller that
 * omitted the language matched no row: no header components, and no
 * body to persist. Matching falls back through
 * exact → same base language → a sensible default.
 */
export async function resolveTemplateRow(
  db: SupabaseClient,
  accountId: string,
  templateName: string,
  requestedLanguage?: string | null
): Promise<ResolvedTemplate> {
  const { data } = await db
    .from('message_templates')
    .select('*')
    .eq('account_id', accountId)
    .eq('name', templateName);

  // Sorted here rather than with `.order()` so the only query-builder
  // surface this helper depends on is select + eq — the same shape the
  // callers' existing fakes implement.
  const rows = ((Array.isArray(data) ? data : []) as { language?: string }[])
    .slice()
    .sort((a, b) => (a.language ?? '').localeCompare(b.language ?? ''));
  const fallbackLanguage = requestedLanguage || 'en_US';

  if (rows.length === 0) {
    return { row: null, malformed: false, language: fallbackLanguage, needsSync: false };
  }

  const pick = (): { language?: string } | undefined => {
    if (requestedLanguage) {
      const wanted = requestedLanguage.toLowerCase();
      const exact = rows.find((r) => r.language?.toLowerCase() === wanted);
      if (exact) return exact;
      return rows.find(
        (r) => r.language && sameLanguageFallback(r.language, requestedLanguage)
      );
    }
    // No language asked for: prefer the historical default, then the
    // bare form Meta's sync produces, then whatever exists.
    return (
      rows.find((r) => r.language === 'en_US') ??
      rows.find((r) => r.language === 'en') ??
      rows[0]
    );
  };

  const chosen = pick();
  if (!chosen) {
    // Rows exist but none in the requested language — the caller pinned
    // a translation this account hasn't synced. Send it anyway; Meta is
    // the authority on which translations are approved.
    return { row: null, malformed: false, language: fallbackLanguage, needsSync: false };
  }

  if (isStubTemplate(chosen)) {
    return {
      row: null,
      malformed: false,
      language: chosen.language || fallbackLanguage,
      needsSync: true,
    };
  }

  if (!isMessageTemplate(chosen)) {
    return { row: null, malformed: true, language: fallbackLanguage, needsSync: false };
  }

  return {
    row: chosen,
    malformed: false,
    // The row's own code: its components are what gets sent, so the
    // language must be the one they belong to (`en` for an `en_US`
    // request resolved to a bare `en` row).
    language: chosen.language || requestedLanguage || 'en_US',
    needsSync: false,
  };
}

/**
 * The text to persist as `messages.content_text` for a template send.
 *
 * `callerText` wins when supplied — the dashboard composer renders the
 * body client-side and posts it, and it knows about header/button
 * values this function doesn't. Otherwise the body is rendered from the
 * local row. Null only when the account has no local copy of the
 * template, which is the one case where we genuinely don't know what
 * the customer saw.
 */
export function templateContentText(
  row: MessageTemplate | null,
  params: string[],
  callerText?: string | null
): string | null {
  if (callerText) return callerText;
  if (!row?.body_text) return null;
  return renderTemplateBody(row.body_text, params);
}
