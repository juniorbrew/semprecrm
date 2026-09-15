// ============================================================
// Quick replies — variable substitution.
//
// A body may contain {{contato.nome}}, {{contato.primeiro_nome}},
// {{atendente.nome}} and {{empresa}} (spaces inside the braces are
// tolerated). Unknown variables and variables without a value render
// as an empty string so the agent never sends a literal "{{…}}".
// ============================================================

/** Everything `renderQuickReply` can fill in. All optional. */
export interface QuickReplyContext {
  /** Contact display name (`contacts.name`). */
  contactName?: string | null;
  /** Current agent's display name (`profiles.full_name`). */
  agentName?: string | null;
  /** Account name (`accounts.name`). */
  companyName?: string | null;
}

/** Variable tokens offered by the settings editor, in display order. */
export const QUICK_REPLY_VARIABLES = [
  'contato.nome',
  'contato.primeiro_nome',
  'atendente.nome',
  'empresa',
] as const;

export type QuickReplyVariable = (typeof QUICK_REPLY_VARIABLES)[number];

/** `contato.nome` → `{{contato.nome}}` (what the editor buttons insert). */
export function variableToken(name: QuickReplyVariable): string {
  return `{{${name}}}`;
}

const VARIABLE_RE = /\{\{\s*([a-zA-Z_][\w.]*)\s*\}\}/g;

function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? '';
}

function clean(value: string | null | undefined): string {
  return (value ?? '').trim();
}

/** Value for one variable name, or '' when unknown / missing. */
export function resolveQuickReplyVariable(name: string, ctx: QuickReplyContext): string {
  switch (name) {
    case 'contato.nome':
      return clean(ctx.contactName);
    case 'contato.primeiro_nome':
      return firstName(clean(ctx.contactName));
    case 'atendente.nome':
      return clean(ctx.agentName);
    case 'empresa':
      return clean(ctx.companyName);
    default:
      return '';
  }
}

/**
 * Replace every `{{variable}}` in `body`. Double spaces left behind by
 * an empty variable collapse to one so "Olá  , tudo bem" doesn't
 * happen; punctuation is left alone to keep the output predictable.
 */
export function renderQuickReply(body: string, ctx: QuickReplyContext = {}): string {
  return body
    .replace(VARIABLE_RE, (_match, name: string) => resolveQuickReplyVariable(name, ctx))
    .replace(/ {2,}/g, ' ');
}
