// ============================================================
// Internal chat — attachments (phase 2). Pure helpers; the upload
// itself lives in mutations.ts.
//
//   CHAT_INTERNAL_BUCKET      private Storage bucket (migration 039)
//   validateChatAttachment    size / type gate before upload
//   attachmentKind            image / audio / video / document
//   buildChatAttachmentPath   account-<id>/chat/<thread>/<uuid>-<name>
//   attachmentPreview         "📎 Attachment" / "🎤 Audio" (English,
//                             callers translate the label)
//   formatBytes / formatDuration
// ============================================================

import type { ChatAttachment } from '@/types';

export const CHAT_INTERNAL_BUCKET = 'chat-internal';

/** 25 MB — the bucket's `file_size_limit`. */
export const CHAT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/** Signed URL lifetime (spec: 1 h). */
export const CHAT_SIGNED_URL_SECONDS = 60 * 60;

export type ChatAttachmentKind = 'image' | 'audio' | 'video' | 'document';

/** Mirrors the bucket's `allowed_mime_types` (migration 039). */
export const CHAT_ATTACHMENT_MIMES: readonly string[] = [
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/webm', 'audio/x-m4a',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/3gpp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/csv', 'application/zip',
];

/** `accept` attribute for the file picker. */
export const CHAT_ATTACHMENT_ACCEPT = CHAT_ATTACHMENT_MIMES.join(',');

/** Extension → MIME for files the browser reports with an empty / generic type. */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  ogg: 'audio/ogg', oga: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', '3gp': 'video/3gpp',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', csv: 'text/csv', zip: 'application/zip',
};

/** Resolve the MIME we will store: the browser's, else by extension. */
export function resolveAttachmentMime(name: string, type: string | null | undefined): string {
  const t = (type ?? '').trim().toLowerCase();
  if (t && t !== 'application/octet-stream') return t.split(';')[0];
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return MIME_BY_EXT[ext] ?? '';
}

export function attachmentKind(mime: string): ChatAttachmentKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

export type ChatAttachmentValidation =
  | { ok: true; kind: ChatAttachmentKind; mime: string }
  | { ok: false; reason: 'empty' | 'too_large' | 'unsupported_type' };

/** Gate a picked / pasted / recorded file before it is uploaded. */
export function validateChatAttachment(file: {
  name: string;
  type: string;
  size: number;
}): ChatAttachmentValidation {
  if (!file.size || file.size <= 0) return { ok: false, reason: 'empty' };
  if (file.size > CHAT_ATTACHMENT_MAX_BYTES) return { ok: false, reason: 'too_large' };
  const mime = resolveAttachmentMime(file.name, file.type);
  if (!mime || !CHAT_ATTACHMENT_MIMES.includes(mime)) return { ok: false, reason: 'unsupported_type' };
  return { ok: true, kind: attachmentKind(mime), mime };
}

/** File name as stored in the object path: ASCII-safe, ≤ 60 chars, extension kept. */
export function safeAttachmentName(name: string): string {
  const trimmed = name.trim() || 'file';
  const dot = trimmed.lastIndexOf('.');
  const base = (dot > 0 ? trimmed.slice(0, dot) : trimmed)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'file';
  const ext = dot > 0 ? trimmed.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) : '';
  return ext ? `${base}.${ext}` : base;
}

/**
 * Object path for an upload. The first segment is what the Storage
 * policies match on (`account-<id>`), the third is the thread the
 * caller must belong to.
 */
export function buildChatAttachmentPath(
  accountId: string,
  threadId: string,
  fileName: string,
  uuid: string,
): string {
  return `account-${accountId}/chat/${threadId}/${uuid}-${safeAttachmentName(fileName)}`;
}

/** Emoji + English label for previews and push bodies. */
export function attachmentPreview(mime: string | null | undefined): { emoji: string; label: 'Audio' | 'Attachment' } {
  return (mime ?? '').startsWith('audio/')
    ? { emoji: '🎤', label: 'Audio' }
    : { emoji: '📎', label: 'Attachment' };
}

/** Narrow an unknown JSON value to a ChatAttachment (null when malformed). */
export function asChatAttachment(value: unknown): ChatAttachment | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.path !== 'string' || !v.path || typeof v.mime !== 'string' || !v.mime) return null;
  const out: ChatAttachment = {
    path: v.path,
    mime: v.mime,
    name: typeof v.name === 'string' && v.name ? v.name : v.path.split('/').pop() ?? 'file',
    size: typeof v.size === 'number' && Number.isFinite(v.size) ? v.size : 0,
  };
  if (typeof v.width === 'number' && v.width > 0) out.width = v.width;
  if (typeof v.height === 'number' && v.height > 0) out.height = v.height;
  if (typeof v.duration === 'number' && v.duration > 0) out.duration = v.duration;
  return out;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `m:ss` for audio / video lengths. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
