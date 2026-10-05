// ============================================================
// AI agents (profiles, migration 064) — pure helpers, safe to import
// from the client.
//
// An agent is a named set of instructions (+ tone, optional model,
// knowledge on/off). Which agent writes a suggestion:
//   1. an enabled agent linked to one of the contact's tags
//   2. an enabled agent linked to the conversation's WhatsApp number
//      (channel 'official' | 'qr' — one number of each per account)
//   3. the enabled default agent
//   4. none → the account's ai_settings.instructions (phase 1)
// Ties inside a step go to the oldest agent (callers pass them sorted
// by created_at).
//
// Migration 065 adds the automatic-reply settings (mode, pause,
// business hours, reply style, hand-over, safety limits). They are
// stored and validated here; the runtime that acts on them comes later.
// ============================================================

import { isValidModelId } from './providers';
import { parseSkills, type SkillId } from './skills';
import { promptName } from './suggest-reply';

export const AGENT_CHANNELS = ['official', 'qr'] as const;
export type AgentChannel = (typeof AGENT_CHANNELS)[number];

export const AGENT_MODES = ['suggest', 'auto'] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

export const AGENT_LIMITS = {
  nameMaxChars: 80,
  descriptionMaxChars: 300,
  instructionsMaxChars: 4000,
  toneMaxChars: 200,
  maxTags: 50,
  maxAgentsPerAccount: 20,
  testMessageMaxChars: 1000,
  testNameMaxChars: 80,
  minCharsPerMessage: 80,
  maxCharsPerMessage: 1000,
  maxMessagesPerTurn: 5,
  maxAutoRepliesPerDay: 200,
  maxHandoffKeywords: 20,
  handoffKeywordMaxChars: 60,
  handoffMessageMaxChars: 500,
} as const;

/** `business_hours` (065). days: 0 = Sunday … 6 = Saturday. */
export interface AgentBusinessHours {
  enabled: boolean;
  timezone: string;
  start: string;
  end: string;
  days: number[];
}

// Defaults — mirror the column defaults of migration 065.
export const DEFAULT_BUSINESS_HOURS: AgentBusinessHours = {
  enabled: false,
  timezone: 'America/Sao_Paulo',
  start: '08:00',
  end: '18:00',
  days: [1, 2, 3, 4, 5],
};
export const DEFAULT_HANDOFF_KEYWORDS = ['falar com atendente', 'atendente', 'humano', 'pessoa real'];
export const DEFAULT_HANDOFF_MESSAGE =
  'Vou te passar para uma pessoa da nossa equipe. Em instantes alguém continua o atendimento por aqui.';
export const AGENT_DEFAULTS = {
  mode: 'suggest' as AgentMode,
  ignore_groups: true,
  split_messages: true,
  max_chars_per_message: 400,
  handoff_enabled: true,
  max_messages_per_turn: 3,
  max_auto_replies_per_day: 20,
  skills: [] as SkillId[],
};

export interface AiAgent {
  id: string;
  name: string;
  description: string | null;
  instructions: string;
  tone: string | null;
  model: string | null;
  knowledge_enabled: boolean;
  is_default: boolean;
  enabled: boolean;
  channels: AgentChannel[];
  tag_ids: string[];
  mode: AgentMode;
  paused_at: string | null;
  business_hours: AgentBusinessHours;
  ignore_groups: boolean;
  split_messages: boolean;
  max_chars_per_message: number;
  handoff_enabled: boolean;
  handoff_keywords: string[];
  handoff_message: string | null;
  max_messages_per_turn: number;
  max_auto_replies_per_day: number;
  skills: SkillId[];
  created_at: string;
  updated_at?: string;
}

// One literal (not a concatenation) so supabase-js can type the select.
export const AGENT_COLUMNS =
  'id, name, description, instructions, tone, model, knowledge_enabled, is_default, enabled, channels, tag_ids, mode, paused_at, business_hours, ignore_groups, split_messages, max_chars_per_message, handoff_enabled, handoff_keywords, handoff_message, max_messages_per_turn, max_auto_replies_per_day, skills, created_at, updated_at';

export const AGENT_ERRORS = {
  body: 'Body must be a JSON object',
  name: 'The name is required (up to 80 characters).',
  description: 'The description must be at most 300 characters.',
  instructions: 'The instructions are required (up to 4000 characters).',
  tone: 'The tone must be at most 200 characters.',
  model: 'Invalid model id',
  flag: 'On/off settings must be true or false.',
  channels: "'channels' must be a list of 'official' and/or 'qr'",
  tags: "'tag_ids' must be a list of up to 50 tag ids",
  notFound: 'AI agent not found',
  tooMany: 'This account already has the maximum of 20 AI agents.',
  defaultConflict: 'Another agent became the default at the same time. Reload and try again.',
  message: 'Type a customer message to test (up to 1000 characters).',
  mode: "The mode must be 'suggest' or 'auto'.",
  businessHours: 'Invalid business hours: pick a time zone, start and end times and at least one day.',
  maxChars: 'The maximum size per message must be between 80 and 1000 characters.',
  maxMessages: 'The messages per automatic reply must be between 1 and 5.',
  maxReplies: 'The automatic replies per conversation per day must be between 1 and 200.',
  handoffKeywords: 'Up to 20 hand-over words, each up to 60 characters.',
  handoffMessage: 'The hand-over message must be at most 500 characters.',
  skills: 'The skills must be a list of known skills.',
} as const;

const FLAGS = ['knowledge_enabled', 'is_default', 'enabled', 'ignore_groups', 'split_messages', 'handoff_enabled'] as const;

export type AgentWrite = Partial<
  Pick<
    AiAgent,
    | 'name'
    | 'description'
    | 'instructions'
    | 'tone'
    | 'model'
    | (typeof FLAGS)[number]
    | 'channels'
    | 'tag_ids'
    | 'mode'
    | 'paused_at'
    | 'business_hours'
    | 'max_chars_per_message'
    | 'handoff_keywords'
    | 'handoff_message'
    | 'max_messages_per_turn'
    | 'max_auto_replies_per_day'
    | 'skills'
  >
>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HHMM_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Same shape as `ai_agents_business_hours_valid` (065); null when invalid. */
export function parseBusinessHours(v: unknown): AgentBusinessHours | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const b = v as Record<string, unknown>;
  if (typeof b.enabled !== 'boolean' || !isTimeZone(b.timezone)) return null;
  if (typeof b.start !== 'string' || !HHMM_RE.test(b.start) || typeof b.end !== 'string' || !HHMM_RE.test(b.end)) return null;
  const days = b.days;
  if (!Array.isArray(days) || days.length === 0 || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return null;
  return {
    enabled: b.enabled,
    timezone: b.timezone,
    start: b.start,
    end: b.end,
    days: [...new Set(days as number[])].sort((x, y) => x - y),
  };
}

const intIn = (v: unknown, min: number, max: number): v is number =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** Optional text: '' / null → null, trimmed, at most `max` characters. */
function optionalText(v: unknown, max: number): { ok: true; value: string | null } | { ok: false } {
  if (v === null || v === '') return { ok: true, value: null };
  if (typeof v === 'string' && v.trim().length <= max) return { ok: true, value: v.trim() || null };
  return { ok: false };
}

/**
 * Validate a create (`partial = false`: name + instructions required)
 * or an edit (only the fields present). Unknown keys are ignored.
 */
export function parseAgentInput(
  body: unknown,
  partial: boolean,
): { ok: true; write: AgentWrite } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: AGENT_ERRORS.body };
  const b = body as Record<string, unknown>;
  const w: AgentWrite = {};

  if ('name' in b || !partial) {
    const v = typeof b.name === 'string' ? b.name.replace(/\s+/g, ' ').trim() : '';
    if (!v || v.length > AGENT_LIMITS.nameMaxChars) return { ok: false, error: AGENT_ERRORS.name };
    w.name = v;
  }
  if ('description' in b) {
    const v = optionalText(b.description, AGENT_LIMITS.descriptionMaxChars);
    if (!v.ok) return { ok: false, error: AGENT_ERRORS.description };
    w.description = v.value;
  }
  if ('instructions' in b || !partial) {
    const v = typeof b.instructions === 'string' ? b.instructions.trim() : '';
    if (!v || v.length > AGENT_LIMITS.instructionsMaxChars) return { ok: false, error: AGENT_ERRORS.instructions };
    w.instructions = v;
  }
  if ('tone' in b) {
    const v = optionalText(b.tone, AGENT_LIMITS.toneMaxChars);
    if (!v.ok) return { ok: false, error: AGENT_ERRORS.tone };
    w.tone = v.value;
  }
  if ('model' in b) {
    const v = typeof b.model === 'string' ? b.model.trim() : b.model;
    if (v === null || v === '') w.model = null;
    else if (isValidModelId(v)) w.model = v;
    else return { ok: false, error: AGENT_ERRORS.model };
  }
  for (const k of FLAGS) {
    if (k in b) {
      if (typeof b[k] !== 'boolean') return { ok: false, error: AGENT_ERRORS.flag };
      w[k] = b[k] as boolean;
    }
  }
  if ('channels' in b) {
    const v = b.channels;
    if (!Array.isArray(v) || !v.every((c) => (AGENT_CHANNELS as readonly unknown[]).includes(c))) {
      return { ok: false, error: AGENT_ERRORS.channels };
    }
    w.channels = [...new Set(v as AgentChannel[])];
  }
  if ('tag_ids' in b) {
    const v = b.tag_ids;
    if (!Array.isArray(v) || v.length > AGENT_LIMITS.maxTags || !v.every((t) => typeof t === 'string' && UUID_RE.test(t))) {
      return { ok: false, error: AGENT_ERRORS.tags };
    }
    w.tag_ids = [...new Set(v as string[])];
  }
  if ('mode' in b) {
    if (!(AGENT_MODES as readonly unknown[]).includes(b.mode)) return { ok: false, error: AGENT_ERRORS.mode };
    w.mode = b.mode as AgentMode;
  }
  // `paused: boolean` → paused_at is stamped here; the client never sends a time.
  if ('paused' in b) {
    if (typeof b.paused !== 'boolean') return { ok: false, error: AGENT_ERRORS.flag };
    w.paused_at = b.paused ? new Date().toISOString() : null;
  }
  if ('business_hours' in b) {
    const v = parseBusinessHours(b.business_hours);
    if (!v) return { ok: false, error: AGENT_ERRORS.businessHours };
    w.business_hours = v;
  }
  if ('max_chars_per_message' in b) {
    if (!intIn(b.max_chars_per_message, AGENT_LIMITS.minCharsPerMessage, AGENT_LIMITS.maxCharsPerMessage)) {
      return { ok: false, error: AGENT_ERRORS.maxChars };
    }
    w.max_chars_per_message = b.max_chars_per_message;
  }
  if ('max_messages_per_turn' in b) {
    if (!intIn(b.max_messages_per_turn, 1, AGENT_LIMITS.maxMessagesPerTurn)) return { ok: false, error: AGENT_ERRORS.maxMessages };
    w.max_messages_per_turn = b.max_messages_per_turn;
  }
  if ('max_auto_replies_per_day' in b) {
    if (!intIn(b.max_auto_replies_per_day, 1, AGENT_LIMITS.maxAutoRepliesPerDay)) {
      return { ok: false, error: AGENT_ERRORS.maxReplies };
    }
    w.max_auto_replies_per_day = b.max_auto_replies_per_day;
  }
  if ('handoff_keywords' in b) {
    const v = b.handoff_keywords;
    if (!Array.isArray(v) || !v.every((k) => typeof k === 'string')) return { ok: false, error: AGENT_ERRORS.handoffKeywords };
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of v as string[]) {
      const k = raw.replace(/\s+/g, ' ').trim();
      if (!k || seen.has(k.toLowerCase())) continue;
      if (k.length > AGENT_LIMITS.handoffKeywordMaxChars) return { ok: false, error: AGENT_ERRORS.handoffKeywords };
      seen.add(k.toLowerCase());
      out.push(k);
    }
    if (out.length > AGENT_LIMITS.maxHandoffKeywords) return { ok: false, error: AGENT_ERRORS.handoffKeywords };
    w.handoff_keywords = out;
  }
  if ('handoff_message' in b) {
    const v = optionalText(b.handoff_message, AGENT_LIMITS.handoffMessageMaxChars);
    if (!v.ok) return { ok: false, error: AGENT_ERRORS.handoffMessage };
    w.handoff_message = v.value;
  }
  if ('skills' in b) {
    const v = parseSkills(b.skills);
    if (!v) return { ok: false, error: AGENT_ERRORS.skills };
    w.skills = v;
  }
  return { ok: true, write: w };
}

export type AgentMatch = 'tag' | 'channel' | 'default';

/** See the header for the order. `agents` sorted oldest first. */
export function resolveAgent<T extends Pick<AiAgent, 'enabled' | 'is_default' | 'channels' | 'tag_ids'>>(
  agents: readonly T[],
  ctx: { channel: string | null; tagIds: readonly string[] },
): { agent: T; match: AgentMatch } | null {
  const enabled = agents.filter((a) => a.enabled);
  const tags = new Set(ctx.tagIds);
  const byTag = enabled.find((a) => a.tag_ids.some((t) => tags.has(t)));
  if (byTag) return { agent: byTag, match: 'tag' };
  const byChannel = ctx.channel ? enabled.find((a) => (a.channels as string[]).includes(ctx.channel as string)) : undefined;
  if (byChannel) return { agent: byChannel, match: 'channel' };
  const def = enabled.find((a) => a.is_default);
  return def ? { agent: def, match: 'default' } : null;
}

/** The trusted instructions block for a suggestion written by `agent`. */
export function agentInstructions(agent: Pick<AiAgent, 'instructions' | 'tone'>): string {
  const tone = agent.tone?.trim();
  return tone ? `${agent.instructions.trim()}\n\nTom de voz: ${promptName(tone, 200)}` : agent.instructions.trim();
}

/**
 * The trusted instructions of a suggestion: the account's general
 * instructions always apply; a resolved agent's are appended after them.
 */
export function suggestionInstructions(
  general: string | null,
  agent: Pick<AiAgent, 'name' | 'instructions' | 'tone'> | null,
): string | null {
  const base = general?.trim() || null;
  if (!agent) return base;
  const own = agentInstructions(agent);
  return base ? `${base}\n\nInstruções do agente ${promptName(agent.name, 80)}:\n${own}` : own;
}

export type AgentStatus = 'active' | 'paused' | 'disabled';

/** Ativo / Pausado (automatic mode paused) / Desativado. */
export function agentStatus(a: Pick<AiAgent, 'enabled' | 'mode' | 'paused_at'>): AgentStatus {
  if (!a.enabled) return 'disabled';
  return a.mode === 'auto' && a.paused_at ? 'paused' : 'active';
}

/**
 * Split a reply into WhatsApp-sized messages: one per paragraph; a
 * paragraph longer than `maxChars` is cut at sentence ends and packed
 * up to `maxChars`. At most `maxParts` messages — the rest is joined
 * into the last one. Never cuts mid-sentence.
 */
export function splitReply(text: string, maxChars: number, maxParts: number): string[] {
  const parts: string[] = [];
  for (const para of text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
    if (para.length <= maxChars) {
      parts.push(para);
      continue;
    }
    let cur = '';
    for (const s of (para.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [para]).map((x) => x.trim()).filter(Boolean)) {
      if (cur && cur.length + 1 + s.length > maxChars) {
        parts.push(cur);
        cur = s;
      } else cur = cur ? `${cur} ${s}` : s;
    }
    if (cur) parts.push(cur);
  }
  if (parts.length <= maxParts) return parts;
  return [...parts.slice(0, maxParts - 1), parts.slice(maxParts - 1).join('\n\n')];
}
