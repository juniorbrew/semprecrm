import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { OPTIONAL_MODULES, PLAN_CATALOG } from './plans'

// Migration 113 carries the current copy of the SQL module lists. A module missing there can
// never be granted to an account.
const sql = readFileSync(join(process.cwd(), 'supabase/migrations/113_booking_pages.sql'), 'utf8')

describe('migration 113 module lists', () => {
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

  it('grants booking_page to trial, pro and empresa but not basico (catalogue matches the SQL)', () => {
    for (const plan of ['trial', 'pro', 'empresa'] as const) {
      expect(PLAN_CATALOG[plan].modules).toContain('booking_page')
    }
    expect(PLAN_CATALOG.basico.modules).not.toContain('booking_page')
    expect(sql).toContain("pv.plan IN ('trial', 'pro', 'empresa')")
  })

  it('accepts the client source in the booking RPC and the constraint', () => {
    expect(sql).toContain("p_source NOT IN ('agent', 'ai', 'api', 'client')")
    expect(sql).toContain("booking_source IN ('agent', 'ai', 'api', 'client')")
  })
})
