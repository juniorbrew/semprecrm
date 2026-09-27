// ============================================================
// Header media for broadcast templates (wacrm #298, upstream 33942dc).
//
// A template with an IMAGE/VIDEO/DOCUMENT header needs a media link on
// EVERY send — Meta rejects the message without the header component.
// The wizard collects that link in the personalize step and the hook
// ships it as `messageParams.headerMediaUrl`; these helpers hold the
// rules so the step, the hook and the tests agree.
//
// SempreCRM difference: the template's stored `header_media_url` may be
// origin-relative (`/supabase/storage/v1/object/public/...`, our own
// chat-media upload). template-send-builder absolutises it against the
// site URL before handing it to Meta, so a relative stored URL is a
// valid value here too — only a pasted link must be absolute http(s).
// ============================================================

import { isRelativeMediaUrl } from '@/lib/storage/media-url';
import type { MessageTemplate } from '@/types';

export const MEDIA_HEADER_TYPES = ['image', 'video', 'document'] as const;
export type MediaHeaderType = (typeof MEDIA_HEADER_TYPES)[number];

export function isMediaHeaderType(value: unknown): value is MediaHeaderType {
  return MEDIA_HEADER_TYPES.includes(value as MediaHeaderType);
}

/** The template's media header type, or null for text / no header. */
export function mediaHeaderTypeOf(
  template: Pick<MessageTemplate, 'header_type'>,
): MediaHeaderType | null {
  return isMediaHeaderType(template.header_type) ? template.header_type : null;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validation for the header-media field. `null` = OK (or no media
 * header at all); 'missing' / 'invalid' block the wizard's Next.
 */
export function headerMediaUrlError(
  headerType: MediaHeaderType | null,
  url: string,
): 'missing' | 'invalid' | null {
  if (!headerType) return null;
  const value = url.trim();
  if (!value) return 'missing';
  if (isRelativeMediaUrl(value)) return null;
  if (!isValidHttpUrl(value)) return 'invalid';
  return null;
}

/**
 * `messageParams` for the broadcast API: only for media-header
 * templates and only when a URL was given (the send builder falls back
 * to the template's stored URL otherwise).
 */
export function headerMediaMessageParams(
  template: Pick<MessageTemplate, 'header_type'>,
  url: string | null | undefined,
): { headerMediaUrl: string } | undefined {
  const headerMediaUrl = url?.trim();
  return mediaHeaderTypeOf(template) && headerMediaUrl
    ? { headerMediaUrl }
    : undefined;
}
