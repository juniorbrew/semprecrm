import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { OPTIONAL_MODULES } from './plans'

// The database keeps its own copy of the module list (valid_plan_definition and
// platform_update_account_v2). A module missing there can never be granted.
const LATER: readonly string[] = ['channel_instagram', 'channel_messenger']
const sql = readFileSync(join(process.cwd(), 'supabase/migrations/099_modules_per_account.sql'), 'utf8')

describe('migration 099 module lists', () => {
  it('both SQL lists name every optional module', () => {
    const vpd = sql.slice(sql.indexOf('valid_plan_definition'), sql.indexOf('platform_update_account_v2'))
    const upd = sql.slice(sql.indexOf('v_allowed_modules TEXT[]'), sql.indexOf('];', sql.indexOf('v_allowed_modules TEXT[]')))
    // Modules added after 099 are checked against migration 101 (plans-migration-101.test.ts).
    for (const m of OPTIONAL_MODULES.filter((o) => !LATER.includes(o))) {
      expect(vpd, `valid_plan_definition lacks ${m}`).toContain(`'${m}'`)
      expect(upd, `platform_update_account_v2 lacks ${m}`).toContain(`'${m}'`)
    }
  })
})
