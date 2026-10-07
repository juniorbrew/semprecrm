import { beforeEach, describe, expect, it, vi } from 'vitest';
const {
  getUser,
  rpc,
  loadGateCredentials,
  hasGateSession,
  adminFactory,
  from,
  calls,
  result,
} = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn(),
  loadGateCredentials: vi.fn(),
  hasGateSession: vi.fn(),
  adminFactory: vi.fn(),
  from: vi.fn(),
  calls: [] as unknown[][],
  result: { data: [] as Record<string, unknown>[], error: null as unknown },
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser }, rpc }),
}));
vi.mock('@/lib/platform/gate', () => ({ loadGateCredentials, hasGateSession }));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: adminFactory,
}));
import { GET } from './route';
const id = '00000000-0000-4000-8000-000000000001';
const ctx = (accountId = id) => ({ params: Promise.resolve({ accountId }) });
const req = (query = 'section=members') =>
  new Request(`http://localhost/api/platform/accounts/${id}/activity?${query}`);
beforeEach(() => {
  calls.length = 0;
  result.data = [];
  result.error = null;
  getUser.mockResolvedValue({ data: { user: { id } }, error: null });
  rpc.mockImplementation(async (name: string) => ({
    data: name === 'is_platform_admin' ? true : [{ id }],
    error: null,
  }));
  loadGateCredentials.mockResolvedValue({ userId: id });
  hasGateSession.mockResolvedValue(true);
  const q: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'gt', 'order', 'or', 'limit'])
    q[method] = (...args: unknown[]) => {
      calls.push([method, ...args]);
      return q;
    };
  q.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve(resolve(result));
  from.mockImplementation((table: string) => {
    calls.push(['from', table]);
    return q;
  });
  adminFactory.mockReturnValue({ from });
});
describe('platform account activity API', () => {
  it('denies anonymous access before privileged queries', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    expect((await GET(req(), ctx())).status).toBe(401);
    expect(adminFactory).not.toHaveBeenCalled();
  });
  it('denies tenant administrators before privileged queries', async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    expect((await GET(req(), ctx())).status).toBe(403);
    expect(adminFactory).not.toHaveBeenCalled();
  });
  it('enforces the second gate before privileged queries', async () => {
    hasGateSession.mockResolvedValue(false);
    const response = await GET(req(), ctx());
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'gate_locked' });
    expect(adminFactory).not.toHaveBeenCalled();
  });
  it.each([
    'section=unknown',
    'section=members&cursor=garbage',
    'section=channels&cursor={}',
    'section=history&cursor=' +
      encodeURIComponent(
        JSON.stringify({ created_at: '2026-10-07T12:00:00Z),id.gt.0', id })
      ),
  ])('rejects malformed query %s', async (query) => {
    expect((await GET(req(query), ctx())).status).toBe(400);
    expect(adminFactory).not.toHaveBeenCalled();
  });
  it('rejects invalid IDs before privileged queries', async () => {
    expect((await GET(req(), ctx('invalid'))).status).toBe(400);
    expect(adminFactory).not.toHaveBeenCalled();
  });
  it('returns not found without privileged queries', async () => {
    rpc.mockImplementation(async (name: string) => ({
      data: name === 'is_platform_admin' ? true : [],
      error: null,
    }));
    expect((await GET(req(), ctx())).status).toBe(404);
    expect(adminFactory).not.toHaveBeenCalled();
  });
  it('restricts members to the selected company and projects safe fields', async () => {
    result.data = [
      {
        user_id: id,
        full_name: 'Person',
        email: 'person@example.test',
        account_role: 'owner',
        created_at: '2026-10-07T12:00:00Z',
        token_hash: 'SECRET',
        preferences: 'SECRET',
      },
    ];
    const response = await GET(req(), ctx());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.items).toEqual([
      {
        user_id: id,
        full_name: 'Person',
        email: 'person@example.test',
        account_role: 'owner',
        created_at: '2026-10-07T12:00:00Z',
      },
    ]);
    expect(calls).toContainEqual(['eq', 'account_id', id]);
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('excludes accepted and expired invitations', async () => {
    await GET(req('section=invitations'), ctx());
    expect(calls).toContainEqual(['is', 'accepted_at', null]);
    expect(calls.some((c) => c[0] === 'gt' && c[1] === 'expires_at')).toBe(
      true
    );
  });
  it('does not serialize invitation hashes or acceptance details', async () => {
    result.data = [
      {
        id,
        label: 'Invite',
        role: 'agent',
        created_at: '2026-10-07T12:00:00Z',
        expires_at: '2026-10-08T12:00:00Z',
        token_hash: 'SECRET',
        accepted_by_user_id: 'SECRET',
      },
    ];
    const response = await GET(req('section=invitations'), ctx());
    expect(await response.json()).toEqual({
      items: [
        {
          id,
          label: 'Invite',
          role: 'agent',
          created_at: '2026-10-07T12:00:00Z',
          expires_at: '2026-10-08T12:00:00Z',
        },
      ],
      nextCursor: null,
    });
  });
  it('uses user_id as the member pagination tie breaker', async () => {
    const cursor = { created_at: '2026-10-07T12:00:00Z', id };
    await GET(
      req(
        'section=members&cursor=' + encodeURIComponent(JSON.stringify(cursor))
      ),
      ctx()
    );
    expect(calls).toContainEqual([
      'or',
      `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},user_id.lt.${id})`,
    ]);
    expect(calls).toContainEqual(['order', 'user_id', { ascending: false }]);
  });
  it('paginates by timestamp and ID without serializing audit metadata', async () => {
    result.data = Array.from({ length: 26 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(99 - i).padStart(12, '0')}`,
      action: 'plan.changed',
      actor_name: null,
      created_at: '2026-10-07T12:00:00.123456Z',
      metadata: { secret: 'SECRET' },
    }));
    const response = await GET(req('section=history'), ctx());
    const body = await response.json();
    expect(body.items).toHaveLength(25);
    expect(JSON.stringify(body)).not.toContain('SECRET');
    expect(JSON.parse(body.nextCursor)).toEqual({
      created_at: '2026-10-07T12:00:00.123456Z',
      id: result.data[24].id,
    });
    await GET(
      req('section=history&cursor=' + encodeURIComponent(body.nextCursor)),
      ctx()
    );
    expect(calls).toContainEqual([
      'or',
      `created_at.lt.2026-10-07T12:00:00.123456Z,and(created_at.eq.2026-10-07T12:00:00.123456Z,id.lt.${result.data[24].id})`,
    ]);
  });
  it('returns explicit unavailability instead of a false empty list', async () => {
    result.error = { message: 'SECRET', code: 'XX000' };
    const response = await GET(req(), ctx());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('SECRET');
  });
  it('projects both channel kinds without credentials or raw errors', async () => {
    result.data = [
      {
        id,
        phone_number_id: 'identifier',
        status: 'connected',
        phone_number: '5511999999999',
        display_name: 'QR account',
        connected_at: null,
        updated_at: '2026-10-07T12:00:00Z',
        access_token: 'SECRET',
        verify_token: 'SECRET',
        last_error: 'SECRET',
      },
    ];
    const response = await GET(req('section=channels'), ctx());
    const body = await response.json();
    expect(body.items.map((r: { kind: string }) => r.kind)).toEqual([
      'official',
      'qr',
    ]);
    expect(JSON.stringify(body)).not.toContain('SECRET');
    expect(calls.filter((c) => c[0] === 'eq')).toEqual([
      ['eq', 'account_id', id],
      ['eq', 'account_id', id],
    ]);
  });
});
