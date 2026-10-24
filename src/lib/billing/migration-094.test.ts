import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// The database half cannot run in vitest (supabase/tests/billing_db_block.sql does
// that on a real Postgres); pin the contract the app and the owner rely on.
const dir = join(process.cwd(), 'supabase/migrations')
const sql = readFileSync(join(dir, '094_billing_db_block.sql'), 'utf8')
const rollback = readFileSync(join(process.cwd(), 'supabase/rollback/094_rollback.sql'), 'utf8')

/** (a) CRM data: blocked while read-only. Direct account_id. */
const BLOCKED_DIRECT = [
  'contacts', 'tags', 'custom_fields', 'contact_notes', 'conversations', 'message_templates',
  'pipelines', 'deals', 'broadcasts', 'automations', 'flows', 'companies', 'contact_companies',
  'tasks', 'task_statuses', 'task_comments', 'quick_replies', 'lead_sources', 'deal_loss_reasons',
  'calendar_events', 'conversation_categories', 'conversation_events', 'csat_settings',
  'sla_policies', 'teams', 'team_members', 'routing_rules', 'ai_agents', 'ai_settings',
  'ai_knowledge_items', 'ai_knowledge_chunks', 'ai_contact_memories',
]
/** (a) CRM data without its own account_id: resolved through the parent row. */
const BLOCKED_DERIVED = [
  'contact_tags', 'contact_custom_values', 'messages', 'pipeline_stages', 'broadcast_recipients',
  'automation_steps', 'flow_nodes', 'calendar_event_attendees', 'message_reactions',
]
/** UPDATE is a column-allowlist trigger there (mark as read / LGPD consent). */
const UPDATE_BY_TRIGGER = ['contacts', 'conversations']
/** (b) must stay writable while read-only (login, profile, push, channel, chat, account). */
const STAY_WRITABLE = [
  'accounts', 'profiles', 'push_subscriptions', 'account_invitations', 'whatsapp_config',
  'wa_qr_sessions', 'chat_messages', 'chat_message_receipts', 'chat_message_reactions',
  'chat_thread_members', 'storage',
]

/** Tables that carry a write policy (INSERT/UPDATE/DELETE/ALL) after all migrations before 094. */
function writableTables(): Set<string> {
  const policies = new Map<string, { table: string; cmd: string }>()
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  for (const f of files) {
    if (f.startsWith('094_')) continue
    const text = readFileSync(join(dir, f), 'utf8').replace(/--.*$/gm, '')
    const re =
      /CREATE\s+POLICY\s+("[^"]+"|\w+)\s+ON\s+(?:public\.)?(\w+)([\s\S]*?);|DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?("[^"]+"|\w+)\s+ON\s+(?:public\.)?(\w+)|DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?(\w+)/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      if (m[1]) {
        const found = /FOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)/i.exec(m[3] ?? '')
        const cmd = (found ? found[1]! : 'ALL').toUpperCase()
        policies.set(`${m[2]}|${m[1].replace(/"/g, '')}`, { table: m[2]!, cmd })
      } else if (m[4]) {
        policies.delete(`${m[5]}|${m[4].replace(/"/g, '')}`)
      } else if (m[6]) {
        for (const k of [...policies.keys()]) if (k.startsWith(`${m[6]}|`)) policies.delete(k)
      }
    }
  }
  return new Set([...policies.values()].filter((p) => p.cmd !== 'SELECT').map((p) => p.table))
}

describe('migration 094 contract: parses', () => {
  it('opens and closes every function body with $$ (a lone $ does not parse)', () => {
    expect(sql).not.toMatch(/^AS \$\s*$/m)
    expect(sql).not.toMatch(/^\$;\s*$/m)
    const opens = sql.match(/^AS \$\$$/gm)?.length ?? 0
    const closes = (sql.match(/^(END )?\$\$;$/gm) ?? []).length
    expect(opens).toBe(closes)
  })
})

describe('migration 094 contract: account_is_writable', () => {
  const fn = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION public.account_is_writable'),
    sql.indexOf('COMMENT ON FUNCTION public.account_is_writable'),
  )

  it('is STABLE SECURITY DEFINER with a pinned search_path and returns boolean', () => {
    expect(fn).toContain('account_is_writable(p_account uuid)')
    expect(fn).toContain('RETURNS boolean')
    expect(fn).toMatch(/\nSTABLE\n/)
    expect(fn).toMatch(/\nSECURITY DEFINER\n/)
    expect(fn).toContain('SET search_path = public, pg_temp')
  })

  it('mirrors resolveEntitlements: trial/active only, expiry only matters for trial, fail closed', () => {
    expect(fn).toContain("a.plan_status IN ('trial', 'active')")
    expect(fn).toContain("a.plan IN ('trial', 'basico', 'pro', 'empresa')")
    expect(fn).toContain('platform_plan_versions')
    expect(fn).toContain("a.plan_status <> 'trial'")
    expect(fn).toContain('a.plan_expires_at IS NULL')
    expect(fn).toContain('a.plan_expires_at > now()')
    expect(fn).toMatch(/COALESCE\(\(\s*SELECT[\s\S]*\), false\)/) // unknown account -> false
    // an active account's valid-until must NOT be consulted outside the trial branch
    expect(fn).not.toMatch(/plan_status = 'active'[\s\S]*plan_expires_at/)
  })

  it('revokes PUBLIC/anon and grants authenticated + service_role (policies run as the caller)', () => {
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.account_is_writable(uuid) FROM PUBLIC, anon;')
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.account_is_writable(uuid) TO authenticated, service_role;',
    )
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.readonly_guard() FROM PUBLIC, anon, authenticated;')
  })

  it('runs in one transaction with a lock timeout', () => {
    expect(sql).toMatch(/^BEGIN;$/m)
    expect(sql).toMatch(/^COMMIT;$/m)
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';")
  })
})

describe('migration 094 contract: policies', () => {
  const policy = (table: string, cmd: string) => {
    const name = `${table}_readonly_${cmd.toLowerCase()}`
    const i = sql.indexOf(`CREATE POLICY ${name} ON public.${table} AS RESTRICTIVE FOR ${cmd} TO authenticated`)
    return i < 0 ? null : sql.slice(i, sql.indexOf(';', i))
  }

  it.each([...BLOCKED_DIRECT, ...BLOCKED_DERIVED])('%s: RESTRICTIVE insert/delete (+ update) for authenticated', (t) => {
    const insert = policy(t, 'INSERT')
    const del = policy(t, 'DELETE')
    expect(insert, `${t} insert`).not.toBeNull()
    expect(insert).toContain('WITH CHECK (public.account_is_writable(')
    expect(del, `${t} delete`).not.toBeNull()
    expect(del).toContain('USING (public.account_is_writable(')
    const update = policy(t, 'UPDATE')
    if (UPDATE_BY_TRIGGER.includes(t)) {
      expect(update, `${t} update is a trigger`).toBeNull()
      expect(sql).toMatch(
        new RegExp(`BEFORE UPDATE ON public\\.${t}\\n  FOR EACH ROW EXECUTE FUNCTION public\\.readonly_guard\\(`),
      )
    } else {
      expect(update, `${t} update`).not.toBeNull()
      expect(update).toContain('USING (public.account_is_writable(')
      expect(update).toContain('WITH CHECK (public.account_is_writable(')
    }
  })

  it.each(BLOCKED_DERIVED)('%s: derives the account through its parent row', (t) => {
    expect(policy(t, 'INSERT')).toContain('SELECT')
  })

  it.each(STAY_WRITABLE)('%s stays writable: no policy and no guard in 094', (t) => {
    expect(sql).not.toMatch(new RegExp(`ON public\\.${t}\\b`))
  })

  it('never restricts SELECT and never creates a permissive policy', () => {
    expect(sql).not.toMatch(/FOR SELECT/)
    expect(sql).not.toMatch(/FOR ALL/)
    const creates = sql.match(/CREATE POLICY/g)?.length ?? 0
    expect(creates).toBeGreaterThan(0)
    expect(sql.match(/AS RESTRICTIVE/g)?.length).toBe(creates)
    expect(sql.match(/TO authenticated/g)?.length).toBeGreaterThanOrEqual(creates)
  })

  it('classifies every table that carries a write policy (a new table must be decided)', () => {
    const known = new Set([...BLOCKED_DIRECT, ...BLOCKED_DERIVED, ...STAY_WRITABLE])
    const unknown = [...writableTables()].filter((t) => !known.has(t))
    expect(unknown).toEqual([])
  })
})

describe('migration 094 contract: guards', () => {
  it('guard is invoker (current_user is the caller), fails with 42501 and a recognisable message', () => {
    const g = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.readonly_guard'),
      sql.indexOf('REVOKE ALL ON FUNCTION public.readonly_guard'),
    )
    expect(g).not.toContain('SECURITY DEFINER')
    expect(g).toContain("current_user IN ('authenticated', 'anon') OR auth.uid() IS NOT NULL")
    expect(g).toContain("USING ERRCODE = '42501'")
    expect(g).toContain("'read_only_account:")
  })

  it('only the mark-as-read and LGPD-consent columns stay writable on conversations/contacts', () => {
    expect(sql).toContain("readonly_guard('unread_count')")
    expect(sql).toContain("readonly_guard('consent_status', 'consent_updated_at', 'opted_out_at')")
  })

  it('guard triggers sort before every other BEFORE trigger', () => {
    expect(sql).toContain('TRIGGER _00_readonly_guard BEFORE UPDATE ON public.conversations')
  })

  it('rollback drops every policy, trigger and function created', () => {
    for (const m of sql.matchAll(/CREATE POLICY (\w+) ON public\.(\w+)/g)) {
      expect(rollback).toContain(`DROP POLICY IF EXISTS ${m[1]} ON public.${m[2]};`)
    }
    for (const t of ['conversations', 'contacts', 'ai_knowledge_items', 'ai_knowledge_chunks', 'ai_agents']) {
      expect(rollback).toContain(`DROP TRIGGER IF EXISTS _00_readonly_guard ON public.${t};`)
    }
    expect(rollback).toContain('DROP FUNCTION IF EXISTS public.readonly_guard();')
    expect(rollback).toContain('DROP FUNCTION IF EXISTS public.account_is_writable(uuid);')
  })
})
