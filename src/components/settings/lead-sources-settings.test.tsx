// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';


const rows = vi.hoisted(() => ({
  lead_sources: [
    {
      id: 'w1', account_id: 'acct-1', name: 'Landing de inverno', token: 'a'.repeat(64), is_active: true, kind: 'webhook',
      public_key: null, bot_config: {}, pipeline_id: null, stage_id: null, tag_ids: [], assignee_user_id: null,
      field_map: {}, received_count: 7, last_received_at: null,
    },
    {
      id: 'b1', account_id: 'acct-1', name: 'Robo da Loja', token: 'b'.repeat(64), is_active: true, kind: 'site_bot',
      public_key: 'c'.repeat(32), bot_config: {}, pipeline_id: null, stage_id: null, tag_ids: [], assignee_user_id: null,
      field_map: {}, received_count: 2, last_received_at: null,
    },
  ] as Record<string, unknown>[],
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        order: () => b,
        limit: () => b,
        maybeSingle: async () => ({ data: null }),
        then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows[table as 'lead_sources'] ?? [], error: null }).then(ok),
      };
      return b;
    },
  }),
}));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountId: 'acct-1', canManageMembers: true, profileLoading: false }),
  useEntitlements: () => ({ ready: true, modules: { lead_capture: true } }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { LeadSourcesSettings } from './lead-sources-settings';

afterEach(cleanup);

describe('LeadSourcesSettings with site bots', () => {
  it('keeps the webhook list as it was and shows bots in their own group', async () => {
    window.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    render(<LeadSourcesSettings />);
    const webhookName = await screen.findByText('Landing de inverno');
    const webhookTable = webhookName.closest('table')!;
    // the webhook table lists the webhook only, with its own columns
    expect(within(webhookTable).queryByText('Robo da Loja')).toBeNull();
    expect(within(webhookTable).getByText('7')).toBeTruthy();
    // the bot sits in the Site bots group, with its type chip
    const botName = screen.getByText('Robo da Loja');
    const botTable = botName.closest('table')!;
    expect(botTable).not.toBe(webhookTable);
    expect(within(botTable).getByText('Robô do site')).toBeTruthy();
    // both creation entry points exist
    expect(screen.getByRole('button', { name: /Nova fonte de leads/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Novo robô do site/ })).toBeTruthy();
  });

  it('a bot shows the code snippet panel, a webhook source does not', async () => {
    window.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    render(<LeadSourcesSettings />);
    fireEvent.click(await screen.findByText('Landing de inverno'));
    expect(screen.queryByText('Código para colar no seu site')).toBeNull();
    fireEvent.click(screen.getByText('Robo da Loja'));
    expect(screen.getByText('Código para colar no seu site')).toBeTruthy();
    expect(screen.getByText((c) => c.includes(`data-robo="${'c'.repeat(32)}"`))).toBeTruthy();
  });
});
