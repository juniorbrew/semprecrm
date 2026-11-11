// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';

const h = vi.hoisted(() => ({ canEdit: true, readOnly: false }));

vi.mock('@/hooks/use-language', () => ({ useLanguage: () => ({ t: (s: string) => s, language: 'pt-BR' }) }));
vi.mock('@/hooks/use-can', () => ({ useCan: () => h.canEdit }));
vi.mock('@/hooks/use-read-only', () => ({ useReadOnly: () => ({ readOnly: h.readOnly }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { MetaCapiCard } from './meta-capi-card';

const TOKEN = 'EAAB' + 'y'.repeat(40) + 'WXYZ';
const settings = (over: Record<string, unknown> = {}) => ({
  dataset_id: '123456789',
  token_last4: 'WXYZ',
  test_event_code: 'TEST1',
  send_lead: true,
  send_purchase: true,
  enabled: true,
  paused_reason: null,
  ...over,
});
const event = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  deal_title: 'Sofá da Ana',
  event_name: 'lead',
  status: 'sent',
  value: null,
  currency: null,
  last_error: null,
  created_at: new Date().toISOString(),
  ...over,
});

type Reply = { status?: number; body: unknown };
let replies: Record<string, Reply | ((init?: RequestInit) => Reply)>;
let calls: { url: string; init?: RequestInit }[];

beforeEach(() => {
  h.canEdit = true;
  h.readOnly = false;
  calls = [];
  replies = { 'GET /api/meta-capi/settings': { body: { settings: settings(), events: [event()] } } };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const key = `${init?.method ?? 'GET'} ${url}`;
      const r = replies[key];
      const reply = typeof r === 'function' ? r(init) : r ?? { status: 404, body: { error: 'nope' } };
      return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('MetaCapiCard', () => {
  it('renders nothing for non-admins and never fetches', () => {
    h.canEdit = false;
    const { container } = render(<MetaCapiCard />);
    expect(container.innerHTML).toBe('');
    expect(calls).toHaveLength(0);
  });

  it('shows a loading state, then the settings with the masked key and the latest sends', async () => {
    const { container } = render(<MetaCapiCard />);
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(await screen.findByText('Sofá da Ana')).toBeTruthy();
    const key = screen.getByLabelText('Access key') as HTMLInputElement;
    expect(key.value).toBe('');
    expect(key.placeholder).toContain('WXYZ');
    expect((screen.getByLabelText('Dataset ID') as HTMLInputElement).value).toBe('123456789');
    expect(screen.getByText('Sent to Meta')).toBeTruthy();
    expect(screen.getByText('Lead created')).toBeTruthy();
  });

  it('empty state: no sends yet', async () => {
    replies['GET /api/meta-capi/settings'] = { body: { settings: null, events: [] } };
    render(<MetaCapiCard />);
    expect(await screen.findByText(/Nothing sent yet/)).toBeTruthy();
    expect((screen.getByLabelText('Integration on') as HTMLElement).getAttribute('aria-checked')).toBe('false');
  });

  it('error state with a retry that reloads', async () => {
    replies['GET /api/meta-capi/settings'] = { status: 500, body: { error: 'x' } };
    render(<MetaCapiCard />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    replies['GET /api/meta-capi/settings'] = { body: { settings: settings(), events: [] } };
    fireEvent.click(screen.getByText('Try again'));
    expect(await screen.findByText(/Nothing sent yet/)).toBeTruthy();
  });

  it('saves the dataset and a new key in one PUT, then clears the key field', async () => {
    replies['PUT /api/meta-capi/settings'] = (init) => ({ body: { settings: settings({ token_last4: 'WXYZ' }), echoed: init?.body } });
    render(<MetaCapiCard />);
    await screen.findByText('Sofá da Ana');
    fireEvent.change(screen.getByLabelText('Access key'), { target: { value: TOKEN } });
    fireEvent.click(screen.getByText('Save settings'));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const put = calls.find((c) => c.init?.method === 'PUT')!;
    expect(JSON.parse(put.init!.body as string)).toMatchObject({ dataset_id: '123456789', token: TOKEN });
    expect((screen.getByLabelText('Access key') as HTMLInputElement).value).toBe('');
  });

  it('blocks a bad dataset id or key before sending anything', async () => {
    render(<MetaCapiCard />);
    await screen.findByText('Sofá da Ana');
    fireEvent.change(screen.getByLabelText('Dataset ID'), { target: { value: 'abc' } });
    expect(screen.getByText('Use numbers only.')).toBeTruthy();
    expect((screen.getByText('Save settings').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a toggle saves at once', async () => {
    replies['PUT /api/meta-capi/settings'] = { body: { settings: settings({ send_lead: false }) } };
    render(<MetaCapiCard />);
    await screen.findByText('Sofá da Ana');
    fireEvent.click(screen.getByLabelText('Send when a lead is created'));
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true));
    expect(JSON.parse(calls.find((c) => c.init?.method === 'PUT')!.init!.body as string)).toEqual({ send_lead: false });
  });

  it('shows the paused warning', async () => {
    replies['GET /api/meta-capi/settings'] = { body: { settings: settings({ paused_reason: 'invalid_token' }), events: [] } };
    render(<MetaCapiCard />);
    expect(await screen.findByText('Sending paused.')).toBeTruthy();
  });

  it('test event: shows the answer in plain language', async () => {
    replies['POST /api/meta-capi/test'] = { body: { ok: false, message: 'A chave de acesso é inválida ou venceu.' } };
    render(<MetaCapiCard />);
    await screen.findByText('Sofá da Ana');
    fireEvent.click(screen.getByText('Send test event'));
    expect(await screen.findByText('A chave de acesso é inválida ou venceu.')).toBeTruthy();
  });

  it('retry: only failed rows have the button; it calls the route and reloads', async () => {
    replies['GET /api/meta-capi/settings'] = {
      body: { settings: settings(), events: [event({ id: 'ok1' }), event({ id: 'bad1', status: 'failed', last_error: 'A Meta está fora do ar no momento.' })] },
    };
    replies['POST /api/meta-capi/events/bad1/retry'] = { body: { ok: true } };
    render(<MetaCapiCard />);
    expect(await screen.findByText('A Meta está fora do ar no momento.')).toBeTruthy();
    expect(screen.getAllByText('Try again')).toHaveLength(1);
    fireEvent.click(screen.getByText('Try again'));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/meta-capi/events/bad1/retry')).toBe(true));
  });

  it('read-only account: everything is disabled', async () => {
    h.readOnly = true;
    render(<MetaCapiCard />);
    await screen.findByText('Sofá da Ana');
    expect((screen.getByLabelText('Dataset ID') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByText('Send test event').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });
});
