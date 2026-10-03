import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import type { Broadcast } from '@/types';
import {
  BROADCASTS_COPY,
  BroadcastListRow,
  broadcastProgress,
  broadcastStatusDot,
  filterBroadcasts,
  rate,
  readBroadcastsDensity,
  writeBroadcastsDensity,
} from './broadcast-list-row';

const bc = (over: Partial<Broadcast> = {}): Broadcast =>
  ({
    id: 'b1',
    user_id: 'u',
    name: 'Promo setembro',
    template_name: 'promo_set',
    template_language: 'pt_BR',
    status: 'sent',
    total_recipients: 100,
    sent_count: 90,
    delivered_count: 80,
    read_count: 40,
    replied_count: 5,
    failed_count: 10,
    created_at: '2026-09-30T10:00:00Z',
    ...over,
  }) as Broadcast;

describe('broadcastProgress', () => {
  it('splits the cumulative counts into non-overlapping segments', () => {
    expect(broadcastProgress(bc())).toEqual({ read: 40, delivered: 40, sent: 10, failed: 10 });
  });

  it('is null before anything goes out', () => {
    expect(broadcastProgress(bc({ status: 'draft' }))).toBeNull();
    expect(broadcastProgress(bc({ status: 'scheduled' }))).toBeNull();
    expect(broadcastProgress(bc({ total_recipients: 0 }))).toBeNull();
  });

  it('never goes negative or past 100 on inconsistent counts', () => {
    const p = broadcastProgress(bc({ sent_count: 10, delivered_count: 50, read_count: 70, failed_count: 500 }))!;
    expect(p).toEqual({ read: 10, delivered: 0, sent: 0, failed: 100 });
  });
});

describe('helpers', () => {
  it('rate rounds and guards zero', () => {
    expect(rate(1, 3)).toBe(33);
    expect(rate(5, 0)).toBe(0);
  });

  it('status dot falls back to draft', () => {
    expect(broadcastStatusDot('failed')).toContain('bg-red-500');
    expect(broadcastStatusDot('weird')).toBe(broadcastStatusDot('draft'));
  });

  it('filters by status and by name or template', () => {
    const list = [bc({ id: '1' }), bc({ id: '2', name: 'Natal', template_name: 'xmas', status: 'draft' })];
    expect(filterBroadcasts(list, 'draft', '').map((b) => b.id)).toEqual(['2']);
    expect(filterBroadcasts(list, 'all', 'XMAS').map((b) => b.id)).toEqual(['2']);
    expect(filterBroadcasts(list, 'all', ' promo ').map((b) => b.id)).toEqual(['1']);
    expect(filterBroadcasts(list, 'sent', 'natal')).toEqual([]);
  });
});

const render = (b: Broadcast, compact = false) =>
  renderToString(
    <ul>
      <BroadcastListRow
        broadcast={b}
        compact={compact}
        copy={BROADCASTS_COPY['pt-BR']}
        dateLabel="30 de set. de 2026"
        scheduledLabel={null}
        onDelete={() => {}}
      />
    </ul>,
  );

describe('BroadcastListRow', () => {
  it('shows status as dot + text, the meta line, rates and the progress line', () => {
    const html = render(bc({ uncertain_count: 2 }));
    expect(html).toContain('Enviado');
    expect(html).toContain('promo_set · 100 destinatários · 30 de set. de 2026');
    expect(html).toContain('80<!-- -->% <!-- -->entregues');
    expect(html).toContain('data-testid="broadcast-progress"');
    expect(html).toContain('2 incertos');
    expect(html).toContain('href="/broadcasts/b1"');
    expect(html).toContain('aria-label="Mais ações para Promo setembro"');
  });

  it('drafts have no progress line and no empty recipient count', () => {
    const html = render(bc({ status: 'draft', total_recipients: 0 }));
    expect(html).toContain('Rascunho');
    expect(html).not.toContain('broadcast-progress');
    expect(html).not.toContain('destinatário');
  });

  it('compact density drops the second line', () => {
    expect(render(bc({ uncertain_count: 2 }), true)).not.toContain('2 incertos');
  });
});

describe('density preference', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips per user and survives a throwing localStorage', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    writeBroadcastsDensity('u1', 'compact');
    expect(store.get('sempre:broadcasts:density:u1')).toBe('compact');
    expect(readBroadcastsDensity('u1')).toBe('compact');
    expect(readBroadcastsDensity('u2')).toBe('comfortable');
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readBroadcastsDensity('u1')).toBe('comfortable');
    expect(() => writeBroadcastsDensity('u1', 'compact')).not.toThrow();
  });
});
