// ============================================================
// Knowledge base ("Base de conhecimento") — pure helpers, safe to
// import from the client. Migration 063.
//
// Items are FAQs, free texts or uploaded files (extracted text only).
// Each item is split into chunks the database indexes for Portuguese
// full-text search; "Sugerir resposta" sends the best chunks to the
// model. No embeddings — see the migration header for why.
// ============================================================

export const KB_KINDS = ['faq', 'text', 'file'] as const;
export type KbKind = (typeof KB_KINDS)[number];

/** Mirrors the CHECKs in migration 063. */
export const KB_LIMITS = {
  titleMaxChars: 200,
  questionMaxChars: 1000,
  contentMaxChars: 20_000,
  fileContentMaxChars: 200_000,
  fileMaxBytes: 5 * 1024 * 1024,
  maxItemsPerAccount: 500,
  searchQueryMaxChars: 1000,
  /** Chunker targets. */
  chunkTarget: 1000,
  chunkMax: 1200,
  chunkOverlap: 150,
  /** What goes into a suggestion prompt. */
  promptMaxChunks: 5,
  promptMaxChars: 6000,
} as const;

export const KB_FILE_EXTENSIONS = ['txt', 'md', 'csv', 'pdf'] as const;

/** A row of the Settings list (no full text; see KbItem). */
export interface KbItemSummary {
  id: string;
  kind: KbKind;
  title: string;
  source_filename: string | null;
  content_chars: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export const KB_ITEM_SUMMARY_COLUMNS = 'id, kind, title, source_filename, content_chars, enabled, created_at, updated_at';

export interface KbItem {
  id: string;
  kind: KbKind;
  title: string;
  question: string | null;
  content: string;
  source_filename: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface KbSearchHit {
  chunk_id: string;
  item_id: string;
  title: string;
  kind: KbKind;
  content: string;
  rank: number;
}

/**
 * `text.slice(start, end)` that never cuts a surrogate pair in half
 * (an emoji split in two becomes invalid UTF-16 that Postgres rejects).
 */
export function sliceChars(text: string, start: number, end?: number): string {
  let a = start < 0 ? Math.max(0, text.length + start) : Math.min(start, text.length);
  let b = end === undefined ? text.length : end < 0 ? Math.max(0, text.length + end) : Math.min(end, text.length);
  const high = (i: number) => /[\uD800-\uDBFF]/.test(text[i] ?? '');
  const low = (i: number) => /[\uDC00-\uDFFF]/.test(text[i] ?? '');
  if (a > 0 && low(a) && high(a - 1)) a++;
  if (b > 0 && b < text.length && high(b - 1) && low(b)) b--;
  return text.slice(a, Math.max(a, b));
}

/** Remove NULs/control chars Postgres or the prompt shouldn't see; normalise newlines. */
export function cleanText(text: string): string {
  return text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    // Lone surrogates: invalid UTF-16 that Postgres would reject.
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The single chunk of an FAQ item. */
export function faqChunk(question: string, answer: string): string {
  return `Pergunta: ${question.trim()}\nResposta: ${answer.trim()}`;
}

/** Split `text` into pieces no longer than `max`: paragraphs → sentences → words. */
function pieces(text: string, max: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= max) {
      out.push(p);
      continue;
    }
    for (const sentence of p.split(/(?<=[.!?;:])\s+|\n/)) {
      let s = sentence.trim();
      while (s.length > max) {
        const cut = s.lastIndexOf(' ', max);
        const at = cut > max / 2 ? cut : max;
        const head = sliceChars(s, 0, at);
        out.push(head.trim());
        s = s.slice(head.length).trim();
      }
      if (s) out.push(s);
    }
  }
  return out;
}

/** Last ~`n` chars of `text`, starting at a word boundary. */
function tail(text: string, n: number): string {
  if (text.length <= n) return text;
  const t = sliceChars(text, -n);
  const sp = t.indexOf(' ');
  return (sp >= 0 ? t.slice(sp + 1) : t).trim();
}

/**
 * Chunk a text for search: ~1000 chars (never more than 1200 + overlap),
 * split on paragraphs, then sentences, with a small overlap so a fact
 * straddling a boundary is still found whole in one chunk.
 */
export function chunkText(
  text: string,
  { target = KB_LIMITS.chunkTarget, max = KB_LIMITS.chunkMax, overlap = KB_LIMITS.chunkOverlap } = {},
): string[] {
  const clean = cleanText(text);
  if (!clean) return [];
  if (clean.length <= max) return [clean];

  const chunks: string[] = [];
  let cur = '';
  for (const piece of pieces(clean, max)) {
    if (cur && cur.length + piece.length + 2 > target) {
      chunks.push(cur);
      const carry = tail(cur, overlap);
      cur = carry && carry.length + piece.length + 2 <= max + overlap ? `${carry}\n\n${piece}` : piece;
    } else {
      cur = cur ? `${cur}\n\n${piece}` : piece;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Chunks for an item as stored. */
export function chunksForItem(kind: KbKind, content: string, question: string | null): string[] {
  // A long FAQ answer is chunked too; every chunk repeats the question.
  if (kind === 'faq') return chunkText(content).map((part) => faqChunk(question ?? '', part));
  return chunkText(content);
}

export const KB_ERRORS = {
  body: 'Invalid request body',
  kind: 'Unknown knowledge item type',
  title: `The title is required (up to ${KB_LIMITS.titleMaxChars} characters).`,
  question: `The question is required (up to ${KB_LIMITS.questionMaxChars} characters).`,
  content: `The content is required (up to ${KB_LIMITS.contentMaxChars.toLocaleString('en-US')} characters).`,
  tooMany: `The knowledge base is full (up to ${KB_LIMITS.maxItemsPerAccount} items). Remove items you no longer need.`,
  notFound: 'Knowledge item not found',
  query: 'Type a question to search.',
  fileContent: `The text is too long (up to ${KB_LIMITS.fileContentMaxChars.toLocaleString('en-US')} characters).`,
} as const;

export interface KbItemInput {
  title: string;
  question: string | null;
  content: string;
}

/**
 * Validate a create/edit body for a FAQ or text item (or the editable
 * fields of a file item). `kind` comes from the stored row on edit.
 */
export function parseKbItemInput(
  kind: KbKind,
  body: unknown,
): { ok: true; value: KbItemInput } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: KB_ERRORS.body };
  const b = body as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');

  const content = cleanText(str(b.content));
  const title = str(b.title).replace(/\s+/g, ' ').trim();
  const question = kind === 'faq' ? str(b.question).replace(/\s+/g, ' ').trim() : null;

  if (kind === 'faq') {
    if (!question || question.length > KB_LIMITS.questionMaxChars) return { ok: false, error: KB_ERRORS.question };
  }
  // A FAQ is titled by its question, which may be longer than a title.
  const finalTitle = kind === 'faq' ? sliceChars(title || question!, 0, KB_LIMITS.titleMaxChars).trim() : title;
  if (!finalTitle || finalTitle.length > KB_LIMITS.titleMaxChars) return { ok: false, error: KB_ERRORS.title };

  const maxContent = kind === 'file' ? KB_LIMITS.fileContentMaxChars : KB_LIMITS.contentMaxChars;
  if (!content) return { ok: false, error: KB_ERRORS.content };
  if (content.length > maxContent) {
    return { ok: false, error: kind === 'file' ? KB_ERRORS.fileContent : KB_ERRORS.content };
  }
  return { ok: true, value: { title: finalTitle, question, content } };
}

/**
 * Query for "Sugerir resposta": the LAST customer message with text.
 * When it is very short ("e aí?", "quanto?") the previous ones are
 * prepended, up to 3 messages in all. Oldest first, capped.
 */
export function kbQueryFromMessages(
  messages: { sender_type: string; content_text?: string | null }[],
  { maxMessages = 3, minChars = 15 } = {},
): string {
  const texts = messages
    .filter((m) => m.sender_type === 'customer' && m.content_text?.trim())
    .map((m) => m.content_text!.trim());
  const picked: string[] = [];
  for (let i = texts.length - 1; i >= 0 && picked.length < maxMessages; i--) {
    picked.unshift(texts[i]);
    if (picked.join(' ').length >= minChars) break;
  }
  return sliceChars(picked.join('\n'), -KB_LIMITS.searchQueryMaxChars).trim();
}

/** Top hits for the prompt: at most N chunks and a total char budget. */
export function selectKbHits<T extends { content: string }>(
  hits: T[],
  maxChunks: number = KB_LIMITS.promptMaxChunks,
  maxChars: number = KB_LIMITS.promptMaxChars,
): T[] {
  const out: T[] = [];
  let used = 0;
  for (const h of hits.slice(0, maxChunks)) {
    const room = maxChars - used;
    if (room < 200) break;
    const content = h.content.length > room ? `${sliceChars(h.content, 0, room)}…` : h.content;
    out.push({ ...h, content });
    used += content.length;
  }
  return out;
}
