// ============================================================
// Conversation / contact context shared by the AI routes that read a thread
// ("Sugerir resposta", "Extrair fatos"). Server only; everything goes
// through the caller's RLS client and is filtered by the session
// account, so another account's conversation is a plain 404 (null).
// ============================================================

import { NextResponse } from 'next/server';

import type { AccountContext } from '@/lib/auth/account';
import { AiError } from './errors';
import { kbQueryFromMessages, KB_LIMITS, selectKbHits } from './knowledge';
import { AI_LIMITS } from './providers';
import { searchKnowledge } from './store';
import { isPromptableMessage, type SuggestMessage } from './suggest-reply';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CONTACT_ANONYMIZED_ERROR = 'This contact was anonymized (LGPD) — AI suggestions are not available.';

export const contactAnonymizedResponse = () =>
  NextResponse.json({ error: CONTACT_ANONYMIZED_ERROR, code: 'contact_anonymized' }, { status: 403 });

type ContactEmbed = { name?: string | null; anonymized_at?: string | null };

export interface AiConversation {
  id: string;
  channel: string | null;
  contact_id: string;
  contact: ContactEmbed | ContactEmbed[] | null;
}

export async function loadAiConversation(
  ctx: AccountContext,
  id: string,
): Promise<{ conv: AiConversation; contact: ContactEmbed | null } | null> {
  if (!UUID_RE.test(id)) return null;
  const { data, error } = await ctx.supabase
    .from('conversations')
    .select('id, channel, contact_id, contact:contacts(name, anonymized_at)')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (error) throw new Error(`conversation read failed: ${error.message}`);
  if (!data) return null;
  const conv = data as AiConversation;
  const contact = (Array.isArray(conv.contact) ? conv.contact[0] : conv.contact) ?? null;
  return { conv, contact };
}

/**
 * AI settings the prompt needs (throws `not_enabled`) and the newest N
 * messages of this conversation that reached the customer, oldest first.
 */
export async function loadPromptMessages(
  ctx: AccountContext,
  conversationId: string,
): Promise<{ instructions: string | null; messages: SuggestMessage[] }> {
  const { data: settings, error: setErr } = await ctx.supabase
    .from('ai_settings')
    .select('enabled, instructions, suggest_history_messages')
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (setErr) throw new Error(`ai settings read failed: ${setErr.message}`);
  if (!settings?.enabled) throw new AiError('not_enabled');

  const historyLimit = Math.min(
    AI_LIMITS.historyMax,
    Math.max(AI_LIMITS.historyMin, Number(settings.suggest_history_messages) || AI_LIMITS.historyDefault),
  );
  const { data: rows, error: msgErr } = await ctx.supabase
    .from('messages')
    .select('sender_type, content_type, content_text, template_name, status, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    // Over-fetch a little so failed sends (dropped below) don't eat the window.
    .limit(historyLimit + 20);
  if (msgErr) throw new Error(`messages read failed: ${msgErr.message}`);
  // Newest N that reached the customer (failed sends never did), oldest first.
  const messages = ((rows ?? []) as SuggestMessage[])
    .filter(isPromptableMessage)
    .slice(0, historyLimit)
    .reverse();
  return { instructions: (settings.instructions as string | null) ?? null, messages };
}

/** The contact if it belongs to the caller's account, else null (→ 404). */
export async function loadAiContact(
  ctx: AccountContext,
  contactId: string,
): Promise<{ id: string; anonymized_at: string | null } | null> {
  if (!UUID_RE.test(contactId)) return null;
  const { data, error } = await ctx.supabase
    .from('contacts')
    .select('id, anonymized_at')
    .eq('id', contactId)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (error) throw new Error(`contact read failed: ${error.message}`);
  return (data as { id: string; anonymized_at: string | null } | null) ?? null;
}

/**
 * Knowledge-base snippets for the latest customer messages. A failed
 * search never blocks the suggestion — it just goes out without them.
 */
export async function loadPromptKnowledge(
  ctx: AccountContext,
  messages: SuggestMessage[],
): Promise<{ title: string; content: string }[]> {
  const query = kbQueryFromMessages(messages);
  if (!query) return [];
  try {
    const hits = await searchKnowledge(ctx.supabase, ctx.accountId, query, KB_LIMITS.promptMaxChunks);
    return selectKbHits(hits).map((h) => ({ title: h.title, content: h.content }));
  } catch (err) {
    console.error('[ai] knowledge search failed:', err instanceof Error ? err.message : err);
    return [];
  }
}
