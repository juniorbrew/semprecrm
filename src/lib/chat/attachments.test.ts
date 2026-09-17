import { describe, expect, it } from 'vitest';

import {
  asChatAttachment,
  attachmentKind,
  attachmentPreview,
  buildChatAttachmentPath,
  CHAT_ATTACHMENT_MAX_BYTES,
  formatBytes,
  formatDuration,
  resolveAttachmentMime,
  safeAttachmentName,
  validateChatAttachment,
} from './attachments';

describe('validateChatAttachment', () => {
  it('accepts images, audio, video and documents up to 25 MB', () => {
    expect(validateChatAttachment({ name: 'a.png', type: 'image/png', size: 10 })).toEqual({
      ok: true,
      kind: 'image',
      mime: 'image/png',
    });
    expect(validateChatAttachment({ name: 'v.ogg', type: 'audio/ogg', size: 10 })).toMatchObject({ kind: 'audio' });
    expect(validateChatAttachment({ name: 'v.mp4', type: 'video/mp4', size: 10 })).toMatchObject({ kind: 'video' });
    expect(validateChatAttachment({ name: 'c.pdf', type: 'application/pdf', size: CHAT_ATTACHMENT_MAX_BYTES })).toMatchObject({
      kind: 'document',
    });
  });

  it('rejects empty, oversized and unsupported files', () => {
    expect(validateChatAttachment({ name: 'a.png', type: 'image/png', size: 0 })).toEqual({ ok: false, reason: 'empty' });
    expect(validateChatAttachment({ name: 'a.png', type: 'image/png', size: CHAT_ATTACHMENT_MAX_BYTES + 1 })).toEqual({
      ok: false,
      reason: 'too_large',
    });
    expect(validateChatAttachment({ name: 'x.exe', type: 'application/x-msdownload', size: 5 })).toEqual({
      ok: false,
      reason: 'unsupported_type',
    });
    expect(validateChatAttachment({ name: 'mystery', type: '', size: 5 })).toEqual({ ok: false, reason: 'unsupported_type' });
  });

  it('falls back to the extension when the browser gives no usable type', () => {
    expect(resolveAttachmentMime('report.PDF', '')).toBe('application/pdf');
    expect(resolveAttachmentMime('clip.mov', 'application/octet-stream')).toBe('video/quicktime');
    expect(resolveAttachmentMime('a.png', 'image/png; charset=binary')).toBe('image/png');
    expect(validateChatAttachment({ name: 'notes.docx', type: '', size: 5 })).toMatchObject({ ok: true, kind: 'document' });
  });
});

describe('attachmentKind / attachmentPreview', () => {
  it('maps mimes to kinds and previews', () => {
    expect(attachmentKind('image/webp')).toBe('image');
    expect(attachmentKind('audio/mpeg')).toBe('audio');
    expect(attachmentKind('video/webm')).toBe('video');
    expect(attachmentKind('application/pdf')).toBe('document');
    expect(attachmentPreview('audio/ogg')).toEqual({ emoji: '🎤', label: 'Audio' });
    expect(attachmentPreview('image/png')).toEqual({ emoji: '📎', label: 'Attachment' });
    expect(attachmentPreview(null)).toEqual({ emoji: '📎', label: 'Attachment' });
  });
});

describe('paths', () => {
  it('builds account-<id>/chat/<thread>/<uuid>-<safe name>', () => {
    expect(buildChatAttachmentPath('acc', 'thr', 'Relatório final (v2).PDF', 'uuid')).toBe(
      'account-acc/chat/thr/uuid-Relatorio_final_v2.pdf',
    );
  });

  it('sanitises names, keeps the extension and caps the length', () => {
    expect(safeAttachmentName('  ')).toBe('file');
    expect(safeAttachmentName('.bashrc')).toBe('bashrc');
    expect(safeAttachmentName('a'.repeat(100) + '.jpeg')).toBe('a'.repeat(48) + '.jpeg');
    expect(safeAttachmentName('voice-1.ogg')).toBe('voice-1.ogg');
    expect(safeAttachmentName('weird.ext!!')).toBe('weird.ext');
  });
});

describe('asChatAttachment', () => {
  it('narrows JSON to an attachment and drops junk', () => {
    expect(asChatAttachment(null)).toBeNull();
    expect(asChatAttachment({ path: '' })).toBeNull();
    expect(asChatAttachment({ path: 'p/x.png', mime: 'image/png' })).toEqual({
      path: 'p/x.png',
      mime: 'image/png',
      name: 'x.png',
      size: 0,
    });
    expect(
      asChatAttachment({ path: 'p', mime: 'video/mp4', name: 'v.mp4', size: 12, width: 640, height: 480, duration: 3.5, bogus: 1 }),
    ).toEqual({ path: 'p', mime: 'video/mp4', name: 'v.mp4', size: 12, width: 640, height: 480, duration: 3.5 });
    expect(asChatAttachment({ path: 'p', mime: 'x', width: -1, duration: 0 })).toEqual({ path: 'p', mime: 'x', name: 'p', size: 0 });
  });
});

describe('formatting', () => {
  it('formats bytes and durations', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(200 * 1024)).toBe('200 KB');
    expect(formatBytes(3.5 * 1024 * 1024)).toBe('3.5 MB');
    expect(formatBytes(-1)).toBe('');
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65.4)).toBe('1:05');
  });
});
