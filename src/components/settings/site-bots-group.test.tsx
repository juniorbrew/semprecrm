// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { defaultBotConfig } from '@/lib/site-bot';
import type { LeadSource } from '@/types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const events = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));
vi.mock('@/lib/lead-capture/client', () => ({ listLeadSourceEvents: async () => events.rows }));

import { SiteBotPreview } from './site-bot-preview';
import { botSnippet, SiteBotsGroup } from './site-bots-group';

const KEY = 'b'.repeat(32);
const bot = (over: Partial<LeadSource> = {}) =>
  ({
    id: 'bot-1',
    name: 'Robo da Loja',
    kind: 'site_bot',
    is_active: true,
    public_key: KEY,
    received_count: 4,
    last_received_at: null,
    bot_config: { ...defaultBotConfig(), domains: ['loja.com.br'] },
    ...over,
  }) as unknown as LeadSource;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>).SempreRobo;
});

describe('SiteBotsGroup', () => {
  const props = (over: Partial<Parameters<typeof SiteBotsGroup>[0]> = {}) => ({
    bots: [bot()],
    loading: false,
    selectedId: null as string | null,
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onToggle: vi.fn(),
    ...over,
  });

  it('lists bots with a type chip and offers the create button', () => {
    const p = props();
    render(<SiteBotsGroup {...p} />);
    expect(screen.getByText('Robo da Loja')).toBeTruthy();
    expect(screen.getByText('Robô do site')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Novo robô do site/ }));
    expect(p.onCreate).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Editar'));
    expect(p.onEdit).toHaveBeenCalledWith(p.bots[0]);
    fireEvent.click(screen.getByLabelText('Excluir'));
    expect(p.onDelete).toHaveBeenCalledWith(p.bots[0]);
  });

  it('shows the empty state', () => {
    render(<SiteBotsGroup {...props({ bots: [] })} />);
    expect(screen.getByText('Ainda não há robôs do site')).toBeTruthy();
  });

  it('shows the one-line snippet for the selected bot and copies it', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<SiteBotsGroup {...props({ selectedId: 'bot-1' })} />);
    const snippet = botSnippet(KEY, '');
    expect(snippet).toBe(`<script src="/robo.js" data-robo="${KEY}" async></script>`);
    expect(screen.getByText((c) => c.includes(`data-robo="${KEY}"`) && c.includes('/robo.js'))).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Copiar código/ }));
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect((writeText.mock.calls[0] as unknown as [string])[0]).toMatch(new RegExp(`^<script src=".*/robo\\.js" data-robo="${KEY}" async></script>$`));
    expect(screen.getByText(/WordPress/)).toBeTruthy();
    expect(screen.getByText(/Wix/)).toBeTruthy();
  });

  it('shows the visitor answers of each conversation as plain text, also for a returning contact', async () => {
    events.rows = [
      {
        id: 'e1', status: 'duplicate', created_at: new Date().toISOString(),
        payload: { name: 'Ana', phone: '5511987654321', email: 'ana@x.com', _consent: { at: 'x' } },
      },
      { id: 'e2', status: 'ok', created_at: new Date().toISOString(), payload: { name: '<img src=x onerror=alert(1)>', phone: '5511900000000' } },
    ];
    render(<SiteBotsGroup {...props({ selectedId: 'bot-1' })} />);
    expect(await screen.findByText('Últimas conversas')).toBeTruthy();
    const answers = await screen.findAllByText(/Qual é o seu nome\?: /);
    expect(answers).toHaveLength(2);
    expect(answers[0].textContent).toContain('Qual é o seu nome?: Ana');
    expect(answers[0].textContent).toContain('Qual é o seu WhatsApp (com DDD)?: 5511987654321');
    expect(answers[1].textContent).toContain('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('Contato existente')).toBeTruthy();
    events.rows = [];
  });

  it('says so when a bot has no conversations yet', async () => {
    events.rows = [];
    render(<SiteBotsGroup {...props({ selectedId: 'bot-1' })} />);
    expect(await screen.findByText('Ainda não chegou nenhuma conversa.')).toBeTruthy();
  });

  it('warns when no site is allowed yet', () => {
    render(<SiteBotsGroup {...props({ selectedId: 'bot-1', bots: [bot({ bot_config: { ...defaultBotConfig(), domains: [] } })] })} />);
    expect(screen.getByRole('note').textContent).toContain('Nenhum site foi liberado');
  });

  it('toggles a bot without opening it', () => {
    const p = props();
    render(<SiteBotsGroup {...p} />);
    fireEvent.click(screen.getAllByRole('switch')[0]);
    expect(p.onToggle).toHaveBeenCalledWith(p.bots[0], false);
    expect(p.onSelect).not.toHaveBeenCalled();
  });
});

describe('SiteBotPreview', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renders the real widget from the unsaved draft without any network call, and cleans up', async () => {
    const destroy = vi.fn();
    const mount = vi.fn(() => ({ destroy }));
    ;(window as unknown as { SempreRobo: unknown }).SempreRobo = { mount };
    const fetchMock = vi.fn();
    window.fetch = fetchMock as unknown as typeof fetch;
    const draft = {
      ...defaultBotConfig(),
      domains: ['loja.com.br'],
      questions: [
        ...defaultBotConfig().questions,
        { id: 'q3', text: 'Cor?', type: 'choice' as const, options: ['A', 'B'], required: false, target: 'custom' as const, customFieldId: '11111111-1111-4111-8111-111111111111' },
      ],
      end: { ...defaultBotConfig().end, whatsappEnabled: true, whatsappNumber: '5511999990000' },
    };
    const { unmount } = render(<SiteBotPreview config={draft} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(mount).toHaveBeenCalledTimes(1);
    const opts = (mount.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(opts).toMatchObject({ preview: true, open: true, lang: 'pt' });
    expect(opts.container).toBeInstanceOf(HTMLElement);
    // the public projection only: no field ids, number or domains reach the widget
    const sent = JSON.stringify(opts.config);
    expect(sent).not.toContain('11111111-1111');
    expect(sent).not.toContain('5511999990000');
    expect(sent).not.toContain('loja.com.br');
    // the fake submit builds the link locally and never calls the API
    const submit = opts.submit as (a: Record<string, string>) => Promise<{ whatsapp_url: string | null }>;
    const res = await submit({ nome: 'Ana' });
    expect(res.whatsapp_url).toBe(`https://wa.me/5511999990000?text=${encodeURIComponent('Olá! Sou Ana, vim pelo site.')}`);
    expect(fetchMock).not.toHaveBeenCalled();
    unmount();
    expect(destroy).toHaveBeenCalled();
  });

  it('rebuilds once after the draft settles, not on every keystroke', async () => {
    const destroy = vi.fn();
    const mount = vi.fn(() => ({ destroy }));
    ;(window as unknown as { SempreRobo: unknown }).SempreRobo = { mount };
    const { rerender } = render(<SiteBotPreview config={defaultBotConfig()} />);
    for (const greeting of ['O', 'Ol', 'Olá']) {
      rerender(<SiteBotPreview config={{ ...defaultBotConfig(), greeting }} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
    }
    expect(mount).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(mount).toHaveBeenCalledTimes(1);
  });
});
