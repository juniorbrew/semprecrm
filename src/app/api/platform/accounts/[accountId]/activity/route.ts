import { authorizePlatformApi, platformJson } from '@/lib/platform/api';
import { getPlatformAccount } from '@/lib/platform/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import {
  parseHistoryFilters,
  projectHistoryChanges,
  projectPlanVersionChange,
} from '@/lib/platform/history';
import {
  ACTIVITY_PAGE_SIZE,
  type ActivitySection,
  type PlatformChannel,
} from '@/lib/platform/activity-types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Keep Postgres microseconds intact for stable keyset paging. Only normalized
// ISO timestamps and UUIDs may be interpolated into PostgREST filters.
const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const SECTIONS: ActivitySection[] = [
  'members',
  'invitations',
  'channels',
  'history',
];
type Cursor = { created_at: string; id: string };
function parseCursor(raw: string | null): Cursor | null {
  if (raw === null) return null;
  if (raw.length > 200) throw new Error('Invalid cursor');
  const value = JSON.parse(raw);
  if (
    !value ||
    typeof value.created_at !== 'string' ||
    !TIMESTAMP.test(value.created_at) ||
    !Number.isFinite(Date.parse(value.created_at)) ||
    typeof value.id !== 'string' ||
    !UUID.test(value.id)
  )
    throw new Error('Invalid cursor');
  return { created_at: value.created_at, id: value.id };
}
const text = (value: unknown): string =>
  typeof value === 'string' ? value : '';
const nullable = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> }
) {
  try {
    const auth = await authorizePlatformApi();
    if (auth.response) return auth.response;
    const { accountId } = await params;
    if (!UUID.test(accountId))
      return platformJson({ error: 'Empresa inválida.' }, 400);
    const search = new URL(request.url).searchParams;
    const section = search.get('section') as ActivitySection;
    let cursor: Cursor | null;
    let historyFilters: ReturnType<typeof parseHistoryFilters> | null = null;
    try {
      if (!SECTIONS.includes(section)) throw new Error('Invalid section');
      cursor = parseCursor(search.get('cursor'));
      if (section === 'channels' && cursor) throw new Error('Invalid cursor');
      if (section === 'history') historyFilters = parseHistoryFilters(search);
    } catch {
      return platformJson({ error: 'Consulta ou paginação inválida.' }, 400);
    }
    // Both platform locks and account existence are checked BEFORE creating
    // a privileged client. Every query below is scoped to this account.
    const account = await getPlatformAccount(auth.supabase, accountId);
    if (!account)
      return platformJson({ error: 'Empresa não encontrada.' }, 404);
    const admin = supabaseAdmin();
    if (section === 'channels') {
      const [official, qr] = await Promise.all([
        admin
          .from('whatsapp_config')
          .select('id, phone_number_id, status, connected_at, updated_at')
          .eq('account_id', accountId)
          .limit(1),
        admin
          .from('wa_qr_sessions')
          .select(
            'status, phone_number, display_name, connected_at, updated_at'
          )
          .eq('account_id', accountId)
          .limit(1),
      ]);
      if (official.error || qr.error)
        throw new Error('Channel query unavailable');
      const items: PlatformChannel[] = [];
      const o = official.data?.[0];
      const q = qr.data?.[0];
      if (o)
        items.push({
          id: text(o.id),
          kind: 'official',
          identifier: nullable(o.phone_number_id),
          display_name: null,
          status: text(o.status),
          connected_at: nullable(o.connected_at),
          updated_at: text(o.updated_at),
        });
      if (q)
        items.push({
          id: `qr-${accountId}`,
          kind: 'qr',
          identifier: nullable(q.phone_number),
          display_name: nullable(q.display_name),
          status: text(q.status),
          connected_at: nullable(q.connected_at),
          updated_at: text(q.updated_at),
        });
      return platformJson({ items, nextCursor: null });
    }
    const table =
      section === 'members'
        ? 'profiles'
        : section === 'invitations'
          ? 'account_invitations'
          : 'audit_log';
    const fields =
      section === 'members'
        ? 'user_id, full_name, email, account_role, created_at'
        : section === 'invitations'
          ? 'id, label, role, created_at, expires_at'
          : 'id, action, actor_name, created_at, metadata';
    const idField = section === 'members' ? 'user_id' : 'id';
    let query = admin
      .from(table)
      .select(fields)
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .order(idField, { ascending: false })
      .limit(ACTIVITY_PAGE_SIZE + 1);
    if (section === 'invitations')
      query = query
        .is('accepted_at', null)
        .gt('expires_at', new Date().toISOString());
    if (historyFilters) {
      if (historyFilters.start)
        query = query.gte('created_at', historyFilters.start);
      if (historyFilters.end)
        query = query.lt('created_at', historyFilters.end);
      if (historyFilters.action)
        query = query.eq('action', historyFilters.action);
      if (historyFilters.actor)
        query = query.ilike('actor_name', historyFilters.actor);
    }
    if (cursor)
      query = query.or(
        `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},${idField}.lt.${cursor.id})`
      );
    const { data, error } = await query;
    if (error) throw new Error('Activity query unavailable');
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    const page = rows.slice(0, ACTIVITY_PAGE_SIZE);
    // Explicit projection is defense in depth: even an unexpected DB result
    // cannot serialize credentials, invitation hashes or raw audit metadata.
    const items = page.map((row) =>
      section === 'members'
        ? {
            user_id: text(row.user_id),
            full_name: nullable(row.full_name),
            email: nullable(row.email),
            account_role: text(row.account_role),
            created_at: text(row.created_at),
          }
        : section === 'invitations'
          ? {
              id: text(row.id),
              label: nullable(row.label),
              role: text(row.role),
              created_at: text(row.created_at),
              expires_at: text(row.expires_at),
            }
          : {
              id: text(row.id),
              action: text(row.action),
              actor_name: nullable(row.actor_name),
              created_at: text(row.created_at),
              changes: projectHistoryChanges(row.action, row.metadata),
              plan_version_change: projectPlanVersionChange(
                row.action,
                row.metadata
              ),
            }
    );
    const last = page.at(-1);
    const nextCursor =
      rows.length > ACTIVITY_PAGE_SIZE && last
        ? JSON.stringify({
            created_at: text(last.created_at),
            id: text(last[idField]),
          })
        : null;
    return platformJson({ items, nextCursor });
  } catch {
    console.error('[platform activity] read unavailable');
    return platformJson(
      { error: 'Não foi possível carregar os dados da empresa.' },
      500
    );
  }
}
