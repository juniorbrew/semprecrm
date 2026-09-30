// Conversation categories (migration 071): thin Supabase read/write side.
// RLS: members read, admins write. Same contract as lib/pipelines/loss-reasons:
// the client is passed in, errors are thrown.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { ConversationPriority } from '@/types'
import {
  CATEGORY_LIMITS,
  isCategoryColor,
  isPriority,
  type CategoryColor,
  type ConversationCategory,
} from './model'

type Client = Pick<SupabaseClient, 'from'>

export const CATEGORY_COLUMNS =
  'id, account_id, name, description, color, default_priority, position, archived_at'

export class CategoryNameTakenError extends Error {
  constructor() {
    super('A category with this name already exists')
    this.name = 'CategoryNameTakenError'
  }
}

export interface CategoryDraft {
  name: string
  description?: string | null
  color?: CategoryColor
  default_priority?: ConversationPriority
}

/** Trim + validate a draft; returns the row fields or an error key. */
export function normalizeCategoryDraft(
  draft: Partial<CategoryDraft>,
): { ok: true; fields: Partial<CategoryDraft> } | { ok: false; error: 'name' | 'description' | 'color' | 'priority' } {
  const fields: Partial<CategoryDraft> = {}
  if (draft.name !== undefined) {
    const name = draft.name.trim().replace(/\s+/g, ' ')
    if (!name || name.length > CATEGORY_LIMITS.name) return { ok: false, error: 'name' }
    fields.name = name
  }
  if (draft.description !== undefined) {
    const d = (draft.description ?? '').trim()
    if (d.length > CATEGORY_LIMITS.description) return { ok: false, error: 'description' }
    fields.description = d || null
  }
  if (draft.color !== undefined) {
    if (!isCategoryColor(draft.color)) return { ok: false, error: 'color' }
    fields.color = draft.color
  }
  if (draft.default_priority !== undefined) {
    if (!isPriority(draft.default_priority)) return { ok: false, error: 'priority' }
    fields.default_priority = draft.default_priority
  }
  return { ok: true, fields }
}

/** All categories of the account, archived ones included (old conversations still point at them). */
export async function listCategories(supabase: Client, accountId: string): Promise<ConversationCategory[]> {
  const { data, error } = await supabase
    .from('conversation_categories')
    .select(CATEGORY_COLUMNS)
    .eq('account_id', accountId)
    .order('position', { ascending: true })
    .order('name', { ascending: true })
  if (error) throw error
  return (data ?? []) as ConversationCategory[]
}

function rethrow(error: { code?: string; message: string }): never {
  if (error.code === '23505') throw new CategoryNameTakenError()
  throw error
}

export async function createCategory(
  supabase: Client,
  accountId: string,
  existing: readonly ConversationCategory[],
  draft: CategoryDraft,
): Promise<ConversationCategory> {
  const parsed = normalizeCategoryDraft(draft)
  if (!parsed.ok) throw new Error(`invalid category: ${parsed.error}`)
  const position = existing.reduce((max, c) => Math.max(max, c.position + 1), 0)
  const { data, error } = await supabase
    .from('conversation_categories')
    .insert({ account_id: accountId, position, ...parsed.fields })
    .select(CATEGORY_COLUMNS)
    .single()
  if (error) rethrow(error)
  return data as ConversationCategory
}

export async function updateCategory(
  supabase: Client,
  id: string,
  changes: Partial<CategoryDraft> & { archived?: boolean },
): Promise<void> {
  const { archived, ...rest } = changes
  const parsed = normalizeCategoryDraft(rest)
  if (!parsed.ok) throw new Error(`invalid category: ${parsed.error}`)
  const patch: Record<string, unknown> = { ...parsed.fields }
  if (archived !== undefined) patch.archived_at = archived ? new Date().toISOString() : null
  const { error } = await supabase.from('conversation_categories').update(patch).eq('id', id)
  if (error) rethrow(error)
}
