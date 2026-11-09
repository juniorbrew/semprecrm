// ============================================================
// Settings -> bot editor: the request body of POST /api/site-bots and
// PATCH /api/site-bots/[id], validated into the columns to write.
// Pure. `bot_config` always goes through validateBotConfig.
// ============================================================

import { validateBotConfig } from './config'
import type { BotConfig } from './types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_NAME_LEN = 80
const MAX_TAGS = 20

export interface BotWrite {
  name?: string
  is_active?: boolean
  pipeline_id?: string | null
  stage_id?: string | null
  tag_ids?: string[]
  assignee_user_id?: string | null
  bot_config?: BotConfig
}

export type BotWriteResult = { ok: true; write: BotWrite } | { ok: false; errors: string[] }

const uuidOrNull = (v: unknown): string | null | undefined =>
  v === null ? null : typeof v === 'string' && UUID_RE.test(v) ? v : undefined

export function parseBotWrite(body: unknown, mode: 'create' | 'update'): BotWriteResult {
  const b = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  if (!b) return { ok: false, errors: ['body must be an object'] }
  const errors: string[] = []
  const write: BotWrite = {}

  if (b.name !== undefined || mode === 'create') {
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    if (!name) errors.push('name is required')
    else if (name.length > MAX_NAME_LEN) errors.push(`name must be ${MAX_NAME_LEN} characters or fewer`)
    else write.name = name
  }
  if (b.is_active !== undefined) {
    if (typeof b.is_active !== 'boolean') errors.push('is_active must be true or false')
    else write.is_active = b.is_active
  }
  for (const k of ['pipeline_id', 'stage_id', 'assignee_user_id'] as const) {
    if (b[k] === undefined) continue
    const v = uuidOrNull(b[k])
    if (v === undefined) errors.push(`${k} must be an id or null`)
    else write[k] = v
  }
  if (write.pipeline_id === null) write.stage_id = null
  if (b.tag_ids !== undefined) {
    const ids = Array.isArray(b.tag_ids) ? b.tag_ids : null
    if (!ids || ids.length > MAX_TAGS || ids.some((t) => typeof t !== 'string' || !UUID_RE.test(t))) {
      errors.push('tag_ids must be a list of ids')
    } else {
      write.tag_ids = [...new Set(ids as string[])]
    }
  }
  if (b.config !== undefined || mode === 'create') {
    const cfg = validateBotConfig(b.config)
    if (!cfg.ok) errors.push(...cfg.errors)
    else write.bot_config = cfg.config
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, write }
}

/** Custom field ids a config points at (to check they belong to the account). */
export function customFieldIds(config: BotConfig): string[] {
  return config.questions.flatMap((q) => (q.customFieldId ? [q.customFieldId] : []))
}
