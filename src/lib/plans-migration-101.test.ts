import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { OPTIONAL_MODULES, PLAN_CATALOG } from './plans'

// Migration 101 carries the current copy of the SQL module lists. A module missing there can
// never be granted to an account.
const sql = readFileSync(join(process.cwd(), 'supabase/migrations/101_meta_connect.sql'), 'utf8')

describe('migration 101 module lists', () => {
  it('both SQL lists name every optional module', () => {
    const vpd = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.valid_plan_definition'),
      sql.indexOf('CREATE OR REPLACE FUNCTION public.platform_update_account_v2'),
    )
    const upd = sql.slice(sql.indexOf('v_allowed_modules TEXT[]'), sql.indexOf('];', sql.indexOf('v_allowed_modules TEXT[]')))
    for (const m of OPTIONAL_MODULES) {
      expect(vpd, `valid_plan_definition lacks ${m}`).toContain(`'${m}'`)
      expect(upd, `platform_update_account_v2 lacks ${m}`).toContain(`'${m}'`)
    }
  })

  it('grants the channel modules to trial, pro and empresa but not basico (catalogue matches the SQL)', () => {
    for (const plan of ['trial', 'pro', 'empresa'] as const) {
      expect(PLAN_CATALOG[plan].modules).toEqual(expect.arrayContaining(['channel_instagram', 'channel_messenger']))
    }
    expect(PLAN_CATALOG.basico.modules).not.toContain('channel_instagram')
    expect(PLAN_CATALOG.basico.modules).not.toContain('channel_messenger')
    expect(sql).toContain("pv.plan IN ('trial', 'pro', 'empresa')")
  })
})
