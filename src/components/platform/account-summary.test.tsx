import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlatformAccountRow } from '@/types';
import { PLAN_CATALOG } from '@/lib/plans';
import { PlatformAccountSummary } from './account-summary';

const snapshotAt = '2026-10-07T12:00:00Z';
const row: PlatformAccountRow = {
  id: 'company',
  owner_user_id: 'owner',
  name: 'Empresa',
  plan: 'pro',
  plan_version_id: '39000000-0000-4000-8000-000000000001',
  plan_definition: PLAN_CATALOG.pro,
  plan_status: 'active',
  plan_expires_at: null,
  module_overrides: {},
  limit_overrides: {},
  platform_notes: null,
  owner_name: null,
  owner_email: null,
  members_count: 2,
  pending_invites_count: 3,
  channels_count: 1,
  created_at: snapshotAt,
  updated_at: snapshotAt,
};
const summary = (patch: Partial<PlatformAccountRow>) =>
  renderToStaticMarkup(
    <PlatformAccountSummary
      row={{ ...row, ...patch }}
      snapshotAt={snapshotAt}
    />
  );

describe('saved company summary', () => {
  it('shows occupied user slots including pending invites with individual limits', () => {
    const html = summary({
      limit_overrides: { max_users: 5, max_channels: null },
    });
    expect(html).toContain('5 / 5');
    expect(html).toContain('3 convites pendentes');
    expect(html).toContain('Limite de usuários atingido');
    expect(html).not.toContain('Limite de canais atingido');
    expect(html).toContain('1 / Ilimitado');
  });
  it('formats expiration in Bahia and evaluates expiry against the server snapshot', () => {
    const html = summary({
      plan: 'trial',
      plan_status: 'trial',
      plan_expires_at: '2026-10-08T01:30:00Z',
    });
    expect(html).toContain('07/10/2026, 22:30');
    expect(html).toContain('Plano próximo do vencimento');
    expect(html).not.toContain('Plano vencido');
  });
  it('handles missing owner, invalid expiry and empty zero-capacity accounts', () => {
    const html = summary({
      plan_expires_at: 'invalid',
      members_count: 0,
      pending_invites_count: 0,
      channels_count: 0,
      limit_overrides: { max_users: 0, max_channels: 0 },
    });
    expect(html).toContain('Não informado');
    expect(html).toContain('Sem data de vencimento');
    expect(html).not.toContain('Invalid Date');
    expect(html).not.toContain('Limite de usuários atingido');
    expect(html).toContain('Nenhum alerta de vencimento ou capacidade.');
  });
});
