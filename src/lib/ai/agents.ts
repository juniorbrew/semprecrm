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
// ============================================================

import { isValidModelId } from './providers';

export const AGENT_CHANNELS = ['official', 'qr'] as const;
export type AgentChannel = (typeof AGENT_CHANNELS)[number];

export const AGENT_LIMITS = {
  nameMaxChars: 80,
  instructionsMaxChars: 4000,
  toneMaxChars: 200,
  maxTags: 50,
  maxAgentsPerAccount: 20,
  testMessageMaxChars: 1000,
} as const;

export interface AiAgent {
  id: string;
  name: string;
  instructions: string;
  tone: string | null;
  model: string | null;
  knowledge_enabled: boolean;
  is_default: boolean;
  enabled: boolean;
  channels: AgentChannel[];
  tag_ids: string[];
  created_at: string;
  updated_at?: string;
}

export const AGENT_COLUMNS =
  'id, name, instructions, tone, model, knowledge_enabled, is_default, enabled, channels, tag_ids, created_at, updated_at';

export const AGENT_ERRORS = {
  body: 'Body must be a JSON object',
  name: 'The name is required (up to 80 characters).',
  instructions: 'The instructions are required (up to 4000 characters).',
  tone: 'The tone must be at most 200 characters.',
  model: 'Invalid model id',
  flag: "'knowledge_enabled', 'is_default' and 'enabled' must be true or false",
  channels: "'channels' must be a list of 'official' and/or 'qr'",
  tags: "'tag_ids' must be a list of up to 50 tag ids",
  notFound: 'AI agent not found',
  tooMany: 'This account already has the maximum of 20 AI agents.',
  defaultConflict: 'Another agent became the default at the same time. Reload and try again.',
  message: 'Type a customer message to test (up to 1000 characters).',
} as const;

export type AgentWrite = Partial<
  Pick<AiAgent, 'name' | 'instructions' | 'tone' | 'model' | 'knowledge_enabled' | 'is_default' | 'enabled' | 'channels' | 'tag_ids'>
>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if ('instructions' in b || !partial) {
    const v = typeof b.instructions === 'string' ? b.instructions.trim() : '';
    if (!v || v.length > AGENT_LIMITS.instructionsMaxChars) return { ok: false, error: AGENT_ERRORS.instructions };
    w.instructions = v;
  }
  if ('tone' in b) {
    if (b.tone === null || b.tone === '') w.tone = null;
    else if (typeof b.tone === 'string' && b.tone.trim().length <= AGENT_LIMITS.toneMaxChars) w.tone = b.tone.trim() || null;
    else return { ok: false, error: AGENT_ERRORS.tone };
  }
  if ('model' in b) {
    const v = typeof b.model === 'string' ? b.model.trim() : b.model;
    if (v === null || v === '') w.model = null;
    else if (isValidModelId(v)) w.model = v;
    else return { ok: false, error: AGENT_ERRORS.model };
  }
  for (const k of ['knowledge_enabled', 'is_default', 'enabled'] as const) {
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
  return tone ? `${agent.instructions.trim()}\n\nTom de voz: ${tone}` : agent.instructions.trim();
}
