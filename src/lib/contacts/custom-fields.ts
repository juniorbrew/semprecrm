// Account-level custom contact fields and their per-contact values.
//
// Shared by Settings › Campos personalizados (the catalogue manager) and
// the inbox contact panel (create a field + set this contact's value
// without leaving the thread), so the create rules — duplicate check,
// supported types, the insert payload — live in one place.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { CustomField } from '@/types'

/** Types `custom_fields.field_type` supports today. Values are free text. */
export const CUSTOM_FIELD_TYPES = ['text'] as const
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number]

/** Normalises a typed field name; empty string when nothing usable. */
export function normalizeFieldName(name: string): string {
  return name.trim().replace(/\s+/g, ' ')
}

/** Case-insensitive name clash within an already-loaded field list. */
export function isDuplicateFieldName(
  fields: readonly Pick<CustomField, 'id' | 'field_name'>[],
  name: string,
  exceptId?: string,
): boolean {
  const lower = normalizeFieldName(name).toLowerCase()
  return fields.some(
    (f) => f.id !== exceptId && f.field_name.toLowerCase() === lower,
  )
}

export interface CreateCustomFieldInput {
  name: string
  fieldType?: CustomFieldType
  userId: string
  accountId: string
}

/**
 * Inserts an account-level field definition and returns the row.
 * Throws the Supabase error (RLS: admin+) so callers own the toast.
 */
export async function createCustomField(
  supabase: SupabaseClient,
  input: CreateCustomFieldInput,
): Promise<CustomField> {
  const { data, error } = await supabase
    .from('custom_fields')
    .insert({
      field_name: normalizeFieldName(input.name),
      field_type: input.fieldType ?? 'text',
      user_id: input.userId,
      account_id: input.accountId,
    })
    .select('*')
    .single()
  if (error || !data) {
    throw error ?? new Error('custom_fields insert returned no row')
  }
  return data as CustomField
}

export interface SetContactCustomValueInput {
  contactId: string
  fieldId: string
  value: string
}

/**
 * Sets one contact's value for one field. `contact_custom_values` is
 * UNIQUE(contact_id, custom_field_id), so a non-empty value upserts and
 * an empty one deletes the row (the panel shows "—" for missing rows).
 * Returns the stored (trimmed) value. Throws on failure.
 */
export async function setContactCustomValue(
  supabase: SupabaseClient,
  input: SetContactCustomValueInput,
): Promise<string> {
  const value = input.value.trim()
  if (!value) {
    const { error } = await supabase
      .from('contact_custom_values')
      .delete()
      .eq('contact_id', input.contactId)
      .eq('custom_field_id', input.fieldId)
    if (error) throw error
    return ''
  }
  const { error } = await supabase.from('contact_custom_values').upsert(
    {
      contact_id: input.contactId,
      custom_field_id: input.fieldId,
      value,
    },
    { onConflict: 'contact_id,custom_field_id' },
  )
  if (error) throw error
  return value
}
