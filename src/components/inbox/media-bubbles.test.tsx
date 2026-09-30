import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';

import type { Message } from '@/types';
import { translateLiteral } from '@/lib/i18n';
import { isStickerMedia } from '@/lib/inbox/sticker';
import { buildVCards, isVCardText, parseVCards, vcardPreview } from '@/lib/inbox/vcard';
import { previewText } from '@/lib/whatsapp/inbound';
import { MessageBubble } from './message-bubble';

function msg(extra: Partial<Message>): Message {
  return {
    id: 'm-1',
    conversation_id: 'conv-1',
    sender_type: 'customer',
    content_type: 'text',
    status: 'delivered',
    created_at: '2026-09-28T12:00:00.000Z',
    ...extra,
  } as Message;
}

const VCARD = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'N:Souza;Ana;;;',
  'FN:Ana Souza',
  'TEL;type=CELL;waid=5511988887777:+55 11 98888-7777',
  'END:VCARD',
].join('\n');

describe('sticker detection', () => {
  it('webp without a caption is a sticker; photos and captioned images are not', () => {
    expect(isStickerMedia({ contentType: 'image', url: 'https://cdn/x/sticker.webp?token=1' })).toBe(true);
    expect(isStickerMedia({ contentType: 'image', url: '/api/whatsapp/media/abc', mime: 'image/webp' })).toBe(true);
    expect(isStickerMedia({ contentType: 'image', url: '/api/whatsapp/media/abc', mime: 'image/jpeg' })).toBe(false);
    expect(isStickerMedia({ contentType: 'image', url: '/api/whatsapp/media/abc' })).toBe(false);
    expect(isStickerMedia({ contentType: 'image', url: 'https://cdn/x.webp', caption: 'olha' })).toBe(false);
    expect(isStickerMedia({ contentType: 'video', url: 'https://cdn/x.webp' })).toBe(false);
  });

  it('renders without the bubble frame', () => {
    const html = renderToString(<MessageBubble message={msg({ content_type: 'image', media_url: 'https://cdn/s.webp' })} />);
    expect(html).toContain('data-sticker');
    expect(html).not.toContain('bg-muted text-foreground');
    expect(html).not.toContain('rounded-2xl');
  });

  it('a regular photo keeps its bubble', () => {
    const html = renderToString(<MessageBubble message={msg({ content_type: 'image', media_url: 'https://cdn/p.jpg' })} />);
    expect(html).not.toContain('data-sticker');
    expect(html).toContain('rounded-2xl');
  });
});

describe('vCard parsing', () => {
  it('reads name and phone (waid wins for the digits)', () => {
    expect(isVCardText(VCARD)).toBe(true);
    expect(parseVCards(VCARD)).toEqual([
      { name: 'Ana Souza', phones: ['+55 11 98888-7777'], digits: ['5511988887777'] },
    ]);
  });

  it('handles folded lines, several cards and a missing FN', () => {
    const text = 'BEGIN:VCARD\r\nN:Lima;Bruno;;;\r\nTEL:+55 21\r\n  99999-0000\r\nEND:VCARD\r\nBEGIN:VCARD\r\nFN:Carla\r\nEND:VCARD';
    const cards = parseVCards(text)!;
    expect(cards).toHaveLength(2);
    expect(cards[0].name).toBe('Bruno Lima');
    expect(cards[0].digits[0]).toBe('5521 99999-0000'.replace(/\D/g, ''));
    expect(cards[1]).toEqual({ name: 'Carla', phones: [], digits: [] });
  });

  it('plain text is not a vCard', () => {
    expect(parseVCards('olá')).toBeNull();
    expect(vcardPreview('olá')).toBeNull();
  });

  it('builds a vCard from the Meta webhook payload and previews it', () => {
    const text = buildVCards([
      { name: { formatted_name: 'Ana Souza' }, phones: [{ phone: '+55 11 98888-7777', wa_id: '5511988887777' }] },
    ]);
    expect(parseVCards(text)).toEqual([{ name: 'Ana Souza', phones: ['+55 11 98888-7777'], digits: ['5511988887777'] }]);
    expect(vcardPreview(text)).toBe('Ana Souza');
    expect(previewText(text, 'contacts')).toContain('Ana Souza');
    expect(previewText(null, 'sticker')).toBe('[sticker]');
    expect(previewText('oi', 'text')).toBe('oi');
  });
});

describe('MessageBubble — contact card', () => {
  it('shows a small card with name and phone instead of the raw vCard', () => {
    const html = renderToString(<MessageBubble message={msg({ content_text: VCARD })} />);
    expect(html).toContain('data-testid="contact-card"');
    expect(html).toContain('Ana Souza');
    expect(html).toContain('+55 11 98888-7777');
    expect(html).not.toContain('BEGIN:VCARD');
  });

  it('plain text messages are unaffected', () => {
    const html = renderToString(<MessageBubble message={msg({ content_text: 'oi' })} />);
    expect(html).not.toContain('contact-card');
  });

  it('button copy has pt-BR entries', () => {
    expect(translateLiteral('Save as contact', 'pt-BR')).toBe('Salvar como contato');
    expect(translateLiteral('Open conversation', 'pt-BR')).toBe('Abrir conversa');
  });
});

describe('MessageBubble — voice message', () => {
  it('uses the compact player (speed toggle, seek) for audio', () => {
    const html = renderToString(<MessageBubble message={msg({ content_type: 'audio', media_url: '/api/whatsapp/media/a1' })} />);
    expect(html).toContain('data-testid="audio-player"');
    expect(html).toContain('type="range"');
    expect(html).toContain('1×');
    expect(html).not.toContain('controls');
  });

  it('shows "Audio unavailable" without a media url', () => {
    const html = renderToString(<MessageBubble message={msg({ content_type: 'audio' })} />);
    expect(html).not.toContain('audio-player');
    expect(html).toContain('unavailable');
  });
});
