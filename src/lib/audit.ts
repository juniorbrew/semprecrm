// ============================================================
// Audit log (migration 034) — catalogue + writer.
//
// `audit_log` rows are written ONLY through the service role
// (no client INSERT policy), so every call site is a server route
// that already holds an admin client. `logAudit` never throws: a
// failed audit write is logged to the console and the business
// action proceeds — the trail must never break the product.
//
// The catalogue is the single source of truth for what an "action"
// can be. `POST /api/audit` (client-originated actions such as a
// contact delete done straight through Supabase) accepts only these
// keys, and the Settings → Auditoria filter lists them from here.
//
// This module is isomorphic (no `next/headers`): the labels are
// used by the client-side settings panel, the writer by routes.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Language } from '@/lib/i18n'

export const AUDIT_ACTIONS = {
  MEMBER_INVITED: 'member.invited',
  MEMBER_ROLE_CHANGED: 'member.role_changed',
  MEMBER_REMOVED: 'member.removed',
  ACCOUNT_RENAMED: 'account.renamed',
  ACCOUNT_REGISTRATION_UPDATED: 'account.registration_updated',
  ACCOUNT_OWNERSHIP_TRANSFERRED: 'account.ownership_transferred',
  WHATSAPP_OFFICIAL_SAVED: 'whatsapp.official_saved',
  WHATSAPP_OFFICIAL_REMOVED: 'whatsapp.official_removed',
  WHATSAPP_QR_CONNECTED: 'whatsapp.qr_connected',
  WHATSAPP_QR_LOGGED_OUT: 'whatsapp.qr_logged_out',
  CONTACT_DELETED: 'contact.deleted',
  CONTACT_EXPORTED: 'contact.exported',
  CONTACT_ANONYMIZED: 'contact.anonymized',
  DEAL_DELETED: 'deal.deleted',
  AUTOMATION_ACTIVATED: 'automation.activated',
  AUTOMATION_DEACTIVATED: 'automation.deactivated',
  LEAD_SOURCE_CREATED: 'lead_source.created',
  LEAD_SOURCE_TOKEN_ROTATED: 'lead_source.token_rotated',
  PREFERENCES_UPDATED: 'preferences.updated',
  BRANDING_UPDATED: 'branding.updated',
  PLAN_CHANGED: 'plan.changed',
  MFA_ENROLLED: 'mfa.enrolled',
  MFA_DISABLED: 'mfa.disabled',
} as const

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS]

/** Every catalogue value, in display order. */
export const AUDIT_ACTION_LIST: readonly AuditAction[] = Object.values(AUDIT_ACTIONS)

const ACTION_SET: ReadonlySet<string> = new Set(AUDIT_ACTION_LIST)

export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === 'string' && ACTION_SET.has(value)
}

/** Human labels per language. Kept here (not in i18n-extra) so the
 *  catalogue and its wording travel together. */
export const AUDIT_ACTION_LABELS: Record<Language, Record<AuditAction, string>> = {
  'pt-BR': {
    'member.invited': 'Membro convidado',
    'member.role_changed': 'Papel de membro alterado',
    'member.removed': 'Membro removido',
    'account.renamed': 'Conta renomeada',
    'account.registration_updated': 'Cadastro da empresa atualizado',
    'account.ownership_transferred': 'Propriedade da conta transferida',
    'whatsapp.official_saved': 'WhatsApp oficial salvo',
    'whatsapp.official_removed': 'WhatsApp oficial removido',
    'whatsapp.qr_connected': 'WhatsApp QR conectado',
    'whatsapp.qr_logged_out': 'WhatsApp QR desconectado',
    'contact.deleted': 'Contato excluído',
    'contact.exported': 'Dados do contato exportados',
    'contact.anonymized': 'Contato anonimizado',
    'deal.deleted': 'Negócio excluído',
    'automation.activated': 'Automação ativada',
    'automation.deactivated': 'Automação desativada',
    'lead_source.created': 'Fonte de leads criada',
    'lead_source.token_rotated': 'Token de fonte de leads renovado',
    'preferences.updated': 'Preferências de atendimento atualizadas',
    'branding.updated': 'Marca atualizada',
    'plan.changed': 'Plano alterado',
    'mfa.enrolled': 'Verificação em duas etapas ativada',
    'mfa.disabled': 'Verificação em duas etapas desativada',
  },
  'en-US': {
    'member.invited': 'Member invited',
    'member.role_changed': 'Member role changed',
    'member.removed': 'Member removed',
    'account.renamed': 'Account renamed',
    'account.registration_updated': 'Company registration updated',
    'account.ownership_transferred': 'Account ownership transferred',
    'whatsapp.official_saved': 'Official WhatsApp saved',
    'whatsapp.official_removed': 'Official WhatsApp removed',
    'whatsapp.qr_connected': 'WhatsApp QR connected',
    'whatsapp.qr_logged_out': 'WhatsApp QR logged out',
    'contact.deleted': 'Contact deleted',
    'contact.exported': 'Contact data exported',
    'contact.anonymized': 'Contact anonymized',
    'deal.deleted': 'Deal deleted',
    'automation.activated': 'Automation activated',
    'automation.deactivated': 'Automation deactivated',
    'lead_source.created': 'Lead source created',
    'lead_source.token_rotated': 'Lead source token rotated',
    'preferences.updated': 'Service preferences updated',
    'branding.updated': 'Branding updated',
    'plan.changed': 'Plan changed',
    'mfa.enrolled': 'Two-step verification enabled',
    'mfa.disabled': 'Two-step verification disabled',
  },
}

export function auditActionLabel(action: string, language: Language): string {
  if (isAuditAction(action)) return AUDIT_ACTION_LABELS[language][action]
  return action
}

/** Entity kinds the UI knows how to name. Free text in the DB. */
export const AUDIT_ENTITY_TYPES = [
  'account',
  'member',
  'invitation',
  'whatsapp_config',
  'wa_qr_session',
  'contact',
  'deal',
  'automation',
  'lead_source',
  'preferences',
  'branding',
  'plan',
  'mfa',
] as const

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number]

/**
 * Actions the browser may record through `POST /api/audit`. Everything
 * else is produced by a server route that owns the mutation, so a
 * client claiming e.g. `plan.changed` is rejected.
 */
export const CLIENT_AUDIT_ACTIONS: ReadonlySet<AuditAction> = new Set<AuditAction>([
  AUDIT_ACTIONS.CONTACT_DELETED,
  AUDIT_ACTIONS.DEAL_DELETED,
  AUDIT_ACTIONS.AUTOMATION_ACTIVATED,
  AUDIT_ACTIONS.AUTOMATION_DEACTIVATED,
])

/** Metadata is bounded so a rogue caller cannot stuff megabytes in. */
export const AUDIT_METADATA_MAX_BYTES = 8 * 1024

export interface AuditEntry {
  accountId: string
  /** `null` for platform / gateway actors. */
  actorUserId: string | null
  /** Display name snapshot; resolved from `profiles` when omitted. */
  actorName?: string | null
  action: AuditAction
  entityType: AuditEntityType | string
  entityId?: string | null
  metadata?: Record<string, unknown> | null
}

export interface AuditLogRow {
  id: string
  account_id: string
  actor_user_id: string | null
  actor_name: string | null
  action: string
  entity_type: string
  entity_id: string | null
  metadata: Record<string, unknown>
  created_at: string
}

/**
 * Normalise arbitrary metadata into a plain JSON object under the
 * size cap. Non-objects become `{}`; oversize payloads are replaced by
 * a marker so the row still lands.
 */
export function sanitizeAuditMetadata(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  let json: string
  try {
    json = JSON.stringify(raw)
  } catch {
    return {}
  }
  if (json === undefined) return {}
  if (json.length > AUDIT_METADATA_MAX_BYTES) {
    return { truncated: true, bytes: json.length }
  }
  return JSON.parse(json) as Record<string, unknown>
}

async function resolveActorName(
  admin: SupabaseClient,
  actorUserId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from('profiles')
    .select('full_name, email')
    .eq('user_id', actorUserId)
    .maybeSingle()
  if (error || !data) return null
  const row = data as { full_name?: string | null; email?: string | null }
  return row.full_name?.trim() || row.email?.trim() || null
}

/**
 * Insert one audit row with the service-role client. Never throws;
 * returns `true` when the row was written.
 */
export async function logAudit(admin: SupabaseClient, entry: AuditEntry): Promise<boolean> {
  try {
    if (!isAuditAction(entry.action)) {
      console.error('[audit] refusing unknown action:', entry.action)
      return false
    }
    let actorName = entry.actorName ?? null
    if (!actorName && entry.actorUserId) {
      actorName = await resolveActorName(admin, entry.actorUserId)
    }
    const { error } = await admin.from('audit_log').insert({
      account_id: entry.accountId,
      actor_user_id: entry.actorUserId,
      actor_name: actorName,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId ?? null,
      metadata: sanitizeAuditMetadata(entry.metadata),
    })
    if (error) {
      console.error('[audit] insert failed:', error.message, entry.action)
      return false
    }
    return true
  } catch (err) {
    console.error('[audit] write threw:', err)
    return false
  }
}

/** Retention applied by the cron (spec §3): rows older than this go. */
export const AUDIT_RETENTION_DAYS = 365
