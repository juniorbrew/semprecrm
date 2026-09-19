import { beforeEach, describe, expect, it, vi } from 'vitest';
const { getUser, rpc } = vi.hoisted(() => ({ getUser: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser }, rpc }),
}));
import { GET } from './route';
import { PATCH } from './[id]/route';

const id = '00000000-0000-4000-8000-000000000001';
const ctx = (value = id) => ({ params: Promise.resolve({ id: value }) });
const patch = (body: unknown = { status: 'em_contato' }, headers = {}) =>
  new Request(`http://localhost/api/platform/leads/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  getUser
    .mockReset()
    .mockResolvedValue({ data: { user: { id } }, error: null });
  rpc
    .mockReset()
    .mockImplementation(async (name: string) =>
      name === 'is_platform_admin'
        ? { data: true, error: null }
        : { data: { id, status: 'em_contato' }, error: null }
    );
});
describe('platform leads API', () => {
  it.each(['GET', 'PATCH'])('denies anonymous %s', async (method) => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    const response =
      method === 'GET'
        ? await GET(new Request('http://localhost/api/platform/leads'))
        : await PATCH(patch(), ctx());
    expect(response.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each(['GET', 'PATCH'])(
    'denies tenant %s before accessing data',
    async (method) => {
      rpc.mockResolvedValue({ data: false, error: null });
      const response =
        method === 'GET'
          ? await GET(new Request('http://localhost/api/platform/leads'))
          : await PATCH(patch(), ctx());
      expect(response.status).toBe(403);
      expect(rpc).toHaveBeenCalledTimes(1);
    }
  );
  it('denies invalid/expired session', async () => {
    getUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'invalid JWT secret' },
    });
    expect(
      (await GET(new Request('http://localhost/api/platform/leads'))).status
    ).toBe(401);
  });
  it('validates UUID', async () => {
    expect((await PATCH(patch(), ctx("' OR 1=1"))).status).toBe(400);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it.each([
    {},
    [],
    null,
    { status: 'invalid' },
    { status: 'novo', name: 'overwrite' },
    { status: null },
  ])('rejects invalid patch %j', async (body) => {
    expect((await PATCH(patch(body), ctx())).status).toBe(400);
  });
  it('bounds request body even without content-length', async () => {
    expect(
      (await PATCH(patch({ status: 'x'.repeat(2048) }), ctx())).status
    ).toBe(413);
  });
  it('rejects cross-origin mutations', async () => {
    expect(
      (
        await PATCH(
          patch(undefined, { origin: 'https://attacker.test' }),
          ctx()
        )
      ).status
    ).toBe(403);
  });
  it('only passes id and status with caller session', async () => {
    const response = await PATCH(patch(), ctx());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      lead: { id, status: 'em_contato' },
    });
    expect(rpc).toHaveBeenLastCalledWith('platform_update_lead_status', {
      p_lead_id: id,
      p_status: 'em_contato',
    });
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it.each([
    ['P0002', 404],
    ['42501', 403],
    ['22023', 400],
    ['XX000', 500],
  ])('normalizes RPC %s', async (code, status) => {
    rpc.mockImplementation(async (name: string) =>
      name === 'is_platform_admin'
        ? { data: true }
        : { error: { code, message: 'secret raw SQL table' } }
    );
    const response = await PATCH(patch(), ctx());
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain('secret');
  });
  it.each([
    'limit=101',
    'limit=0',
    'offset=-1',
    'offset=1000001',
    'limit=1.5',
    'status=hacked',
    'kind=other',
    `search=${'x'.repeat(201)}`,
  ])('rejects query %s', async (query) => {
    expect(
      (await GET(new Request(`http://localhost/api/platform/leads?${query}`)))
        .status
    ).toBe(400);
  });
  it('passes search literally to bounded server-side listing', async () => {
    const query = new URLSearchParams({
      search: "x%' OR 1=1--",
      kind: 'contato',
      status: 'novo',
      limit: '10',
      offset: '20',
    });
    expect(
      (await GET(new Request(`http://localhost/api/platform/leads?${query}`)))
        .status
    ).toBe(200);
    expect(rpc).toHaveBeenLastCalledWith('platform_list_leads', {
      p_limit: 10,
      p_offset: 20,
      p_kind: 'contato',
      p_status: 'novo',
      p_search: "x%' OR 1=1--",
    });
  });
});
