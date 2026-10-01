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
  ACCOUNT_CONTACT_UPDATED: 'account.contact_updated',
  ACCOUNT_OWNERSHIP_TRANSFERRED: 'account.ownership_transferred',
  WHATSAPP_OFFICIAL_SAVED: 'whatsapp.official_saved',
  WHATSAPP_OFFICIAL_REMOVED: 'whatsapp.official_removed',
  WHATSAPP_QR_CONNECTED: 'whatsapp.qr_connected',
  WHATSAPP_QR_LOGGED_OUT: 'whatsapp.qr_logged_out',
  CONTACT_DELETED: 'contact.deleted',
  CONTACT_EXPORTED: 'contact.exported',
  CONTACT_ANONYMIZED: 'contact.anonymized',
  DEAL_DELETED: 'deal.deleted',
  COMPANY_DELETED: 'company.deleted',
  AUTOMATION_ACTIVATED: 'automation.activated',
  AUTOMATION_DEACTIVATED: 'automation.deactivated',
  LEAD_SOURCE_CREATED: 'lead_source.created',
  LEAD_SOURCE_TOKEN_ROTATED: 'lead_source.token_rotated',
  PREFERENCES_UPDATED: 'preferences.updated',
  BRANDING_UPDATED: 'branding.updated',
  PLAN_CHANGED: 'plan.changed',
  MFA_ENROLLED: 'mfa.enrolled',
  MFA_DISABLED: 'mfa.disabled',
  AI_SETTINGS_UPDATED: 'ai.settings_updated',
  AI_KEY_SAVED: 'ai.key_saved',
  AI_KEY_REMOVED: 'ai.key_removed',
  AI_KNOWLEDGE_CHANGED: 'ai.knowledge_changed',
  AI_AGENTS_CHANGED: 'ai.agents_changed',
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
    'member.role_changed': 'Função do membro alterada',
    'member.removed': 'Membro removido',
    'account.renamed': 'Conta renomeada',
    'account.registration_updated': 'Cadastro da empresa atualizado',
    'account.contact_updated': 'Contato e endereço da empresa atualizados',
    'account.ownership_transferred': 'Propriedade da conta transferida',
    'whatsapp.official_saved': 'WhatsApp oficial salvo',
    'whatsapp.official_removed': 'WhatsApp oficial removido',
    'whatsapp.qr_connected': 'WhatsApp QR conectado',
    'whatsapp.qr_logged_out': 'WhatsApp QR desconectado',
    'contact.deleted': 'Contato excluído',
    'contact.exported': 'Dados do contato exportados',
    'contact.anonymized': 'Contato anonimizado',
    'deal.deleted': 'Negócio excluído',
    'company.deleted': 'Empresa excluída',
    'automation.activated': 'Automação ativada',
    'automation.deactivated': 'Automação desativada',
    'lead_source.created': 'Fonte de leads criada',
    'lead_source.token_rotated': 'Token de fonte de leads renovado',
    'preferences.updated': 'Preferências de atendimento atualizadas',
    'branding.updated': 'Marca atualizada',
    'plan.changed': 'Plano alterado',
    'mfa.enrolled': 'Verificação em duas etapas ativada',
    'mfa.disabled': 'Verificação em duas etapas desativada',
    'ai.settings_updated': 'Configurações de IA atualizadas',
    'ai.key_saved': 'Chave de API de IA salva',
    'ai.key_removed': 'Chave de API de IA removida',
    'ai.knowledge_changed': 'Base de conhecimento da IA alterada',
    'ai.agents_changed': 'Agentes de IA alterados',
  },
  'en-US': {
    'member.invited': 'Member invited',
    'member.role_changed': 'Member role changed',
    'member.removed': 'Member removed',
    'account.renamed': 'Account renamed',
    'account.registration_updated': 'Company registration updated',
    'account.contact_updated': 'Company contact and address updated',
    'account.ownership_transferred': 'Account ownership transferred',
    'whatsapp.official_saved': 'Official WhatsApp saved',
    'whatsapp.official_removed': 'Official WhatsApp removed',
    'whatsapp.qr_connected': 'WhatsApp QR connected',
    'whatsapp.qr_logged_out': 'WhatsApp QR logged out',
    'contact.deleted': 'Contact deleted',
    'contact.exported': 'Contact data exported',
    'contact.anonymized': 'Contact anonymized',
    'deal.deleted': 'Deal deleted',
    'company.deleted': 'Company deleted',
    'automation.activated': 'Automation activated',
    'automation.deactivated': 'Automation deactivated',
    'lead_source.created': 'Lead source created',
    'lead_source.token_rotated': 'Lead source token rotated',
    'preferences.updated': 'Service preferences updated',
    'branding.updated': 'Branding updated',
    'plan.changed': 'Plan changed',
    'mfa.enrolled': 'Two-step verification enabled',
    'mfa.disabled': 'Two-step verification disabled',
    'ai.settings_updated': 'AI settings updated',
    'ai.key_saved': 'AI API key saved',
    'ai.key_removed': 'AI API key removed',
    'ai.knowledge_changed': 'AI knowledge base changed',
    'ai.agents_changed': 'AI agents changed',
  },
}

export function auditActionLabel(action: string, language: Language): string {
  if (isAuditAction(action)) return AUDIT_ACTION_LABELS[language][action]
  return action
}

/**
 * Human labels for the metadata keys the writers put in `keys` /
 * `changes` (preferences, branding, plan, account registration and
 * contact). The Auditoria panel never shows a raw column name: an
 * unknown key falls back to a de-snaked, sentence-case rendering.
 */
export const AUDIT_FIELD_LABELS: Record<Language, Record<string, string>> = {
  'pt-BR': {
    // account (plan) — platform admin patch
    plan: 'Plano',
    plan_status: 'Status do plano',
    plan_expires_at: 'Validade do plano',
    module_overrides: 'Módulos do plano',
    limit_overrides: 'Limites do plano',
    // branding
    app_name: 'Nome do app',
    logo_url: 'Logotipo',
    primary_color: 'Cor principal',
    // preferences (Atendimento / segurança)
    inbox_sla_minutes: 'SLA de resposta',
    cooling_hours: 'Horas até esfriar',
    opt_out_keywords: 'Palavras de descadastro',
    business_hours: 'Horário de atendimento',
    timezone: 'Fuso horário',
    out_of_hours_enabled: 'Resposta fora do horário',
    out_of_hours_message: 'Mensagem fora do horário',
    auto_assign_enabled: 'Atribuição automática',
    require_mfa_admins: 'Exigir verificação em duas etapas para administradores',
    // company registration / contact
    person_type: 'Tipo de conta',
    tax_id: 'CPF/CNPJ',
    legal_name: 'Razão social',
    trade_name: 'Nome fantasia',
    phone: 'Telefone',
    email: 'E-mail',
    address: 'Endereço',
    name: 'Nome',
    cep: 'CEP',
    street: 'Logradouro',
    number: 'Número',
    complement: 'Complemento',
    neighborhood: 'Bairro',
    city: 'Cidade',
    state: 'UF',
    // members / invitations / mfa
    contact_name: 'Nome do contato',
    member_name: 'Nome do membro',
    role: 'Função',
    label: 'Rótulo',
    expires_at: 'Expira em',
    // contacts (export / anonymise) and deals
    conversations: 'Conversas',
    messages: 'Mensagens',
    messages_scrubbed: 'Mensagens apagadas',
    media_deleted: 'Mídias excluídas',
    notes_deleted: 'Notas excluídas',
    custom_values_deleted: 'Campos personalizados excluídos',
    warnings: 'Avisos',
    deals: 'Negócios',
    tasks: 'Tarefas',
    notes: 'Notas',
    value: 'Valor',
    count: 'Quantidade',
    // WhatsApp
    phone_number: 'Número',
    status: 'Status',
    previous_status: 'Status anterior',
    resumed: 'Sessão retomada',
    registered: 'Registrado na Meta',
    replaced_existing: 'Substituiu a configuração anterior',
    // business hours
    days: 'Dias',
    mon: 'Segunda',
    tue: 'Terça',
    wed: 'Quarta',
    thu: 'Quinta',
    fri: 'Sexta',
    sat: 'Sábado',
    sun: 'Domingo',
    // AI (migration 058)
    enabled: 'Ativado',
    provider: 'Provedor',
    model: 'Modelo',
    instructions: 'Instruções do assistente',
    monthly_budget_cents: 'Orçamento mensal (centavos de US$)',
    suggest_history_messages: 'Mensagens de contexto',
    consent: 'Aviso de tratamento de dados',
    last4: 'Final da chave',
  },
  'en-US': {
    plan: 'Plan',
    plan_status: 'Plan status',
    plan_expires_at: 'Plan expiry',
    module_overrides: 'Plan modules',
    limit_overrides: 'Plan limits',
    app_name: 'App name',
    logo_url: 'Logo',
    primary_color: 'Primary color',
    inbox_sla_minutes: 'Response SLA',
    cooling_hours: 'Cooling hours',
    opt_out_keywords: 'Opt-out keywords',
    business_hours: 'Business hours',
    timezone: 'Timezone',
    out_of_hours_enabled: 'Out-of-hours reply',
    out_of_hours_message: 'Out-of-hours message',
    auto_assign_enabled: 'Auto-assign',
    require_mfa_admins: 'Require MFA for admins',
    person_type: 'Account type',
    tax_id: 'Tax ID',
    legal_name: 'Legal name',
    trade_name: 'Trade name',
    phone: 'Phone',
    email: 'Email',
    address: 'Address',
    name: 'Name',
    cep: 'Postal code',
    street: 'Street',
    number: 'Number',
    complement: 'Complement',
    neighborhood: 'Neighbourhood',
    city: 'City',
    state: 'State',
    contact_name: 'Contact name',
    member_name: 'Member name',
    role: 'Role',
    label: 'Label',
    expires_at: 'Expires at',
    conversations: 'Conversations',
    messages: 'Messages',
    messages_scrubbed: 'Messages scrubbed',
    media_deleted: 'Media deleted',
    notes_deleted: 'Notes deleted',
    custom_values_deleted: 'Custom values deleted',
    warnings: 'Warnings',
    deals: 'Deals',
    tasks: 'Tasks',
    notes: 'Notes',
    value: 'Value',
    count: 'Count',
    phone_number: 'Number',
    status: 'Status',
    previous_status: 'Previous status',
    resumed: 'Session resumed',
    registered: 'Registered with Meta',
    replaced_existing: 'Replaced previous configuration',
    days: 'Days',
    mon: 'Monday',
    tue: 'Tuesday',
    wed: 'Wednesday',
    thu: 'Thursday',
    fri: 'Friday',
    sat: 'Saturday',
    sun: 'Sunday',
    enabled: 'Enabled',
    provider: 'Provider',
    model: 'Model',
    instructions: 'Assistant instructions',
    monthly_budget_cents: 'Monthly budget (US$ cents)',
    suggest_history_messages: 'Context messages',
    consent: 'Data-processing notice',
    last4: 'Key ending',
  },
}

export function auditFieldLabel(key: string, language: Language): string {
  const known = AUDIT_FIELD_LABELS[language][key]
  if (known) return known
  const words = key.replace(/[_.-]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key
}

/** Entity kinds → column label. Free text in the DB, so unknown kinds
 *  get the same de-snaked fallback as field keys. */
export const AUDIT_ENTITY_LABELS: Record<Language, Record<string, string>> = {
  'pt-BR': {
    account: 'Conta',
    member: 'Membro',
    invitation: 'Convite',
    whatsapp_config: 'WhatsApp oficial',
    wa_qr_session: 'WhatsApp QR',
    contact: 'Contato',
    deal: 'Negócio',
    automation: 'Automação',
    lead_source: 'Fonte de leads',
    preferences: 'Preferências',
    branding: 'Marca',
    plan: 'Plano',
    mfa: 'Verificação em duas etapas',
    ai_settings: 'Inteligência Artificial',
    ai_credential: 'Chave de API de IA',
  },
  'en-US': {
    account: 'Account',
    member: 'Member',
    invitation: 'Invitation',
    whatsapp_config: 'Official WhatsApp',
    wa_qr_session: 'WhatsApp QR',
    contact: 'Contact',
    deal: 'Deal',
    automation: 'Automation',
    lead_source: 'Lead source',
    preferences: 'Preferences',
    branding: 'Branding',
    plan: 'Plan',
    mfa: 'Two-step verification',
    ai_settings: 'Artificial Intelligence',
    ai_credential: 'AI API key',
  },
}

export function auditEntityLabel(entityType: string, language: Language): string {
  return AUDIT_ENTITY_LABELS[language][entityType] ?? auditFieldLabel(entityType, language)
}

/** Role codes stored in metadata (`role`, `from`, `to`). */
export const AUDIT_ROLE_LABELS: Record<Language, Record<string, string>> = {
  'pt-BR': { owner: 'Proprietário', admin: 'Administrador', agent: 'Agente', viewer: 'Visualizador' },
  'en-US': { owner: 'Owner', admin: 'Admin', agent: 'Agent', viewer: 'Viewer' },
}

/** Platform admins are stored as "<name> (platform)" — localise the suffix. */
export const AUDIT_ACTOR_SUFFIX: Record<Language, string> = {
  'pt-BR': '(plataforma)',
  'en-US': '(platform)',
}

export function auditActorLabel(actorName: string, language: Language): string {
  return actorName.replace(/\s*\(platform\)\s*$/i, ` ${AUDIT_ACTOR_SUFFIX[language]}`)
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
  'company',
  'automation',
  'lead_source',
  'preferences',
  'branding',
  'plan',
  'mfa',
  'ai_settings',
  'ai_credential',
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
  AUDIT_ACTIONS.COMPANY_DELETED,
  AUDIT_ACTIONS.AUTOMATION_ACTIVATED,
  AUDIT_ACTIONS.AUTOMATION_DEACTIVATED,
])

/**
 * Metadata keys a client may send per client-recordable action (the
 * fields the pages actually pass to `recordAudit`). Anything else is
 * dropped, so an agent cannot plant free-form text in the admin log.
 */
const CLIENT_AUDIT_METADATA_KEYS: Partial<Record<AuditAction, readonly string[]>> = {
  [AUDIT_ACTIONS.CONTACT_DELETED]: ['contact_name', 'phone', 'count', 'ids', 'bulk'],
  [AUDIT_ACTIONS.DEAL_DELETED]: ['name', 'value', 'contact_id'],
  [AUDIT_ACTIONS.COMPANY_DELETED]: ['name', 'cnpj'],
  [AUDIT_ACTIONS.AUTOMATION_ACTIVATED]: ['name'],
  [AUDIT_ACTIONS.AUTOMATION_DEACTIVATED]: ['name'],
}
const CLIENT_AUDIT_STRING_MAX = 200
const CLIENT_AUDIT_IDS_MAX = 200

/**
 * Reduce client-supplied metadata to the per-action allowlist: scalar
 * values only (strings clipped), plus `ids` as a bounded string list.
 */
export function sanitizeClientAuditMetadata(
  action: AuditAction,
  raw: unknown,
): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const allowed = CLIENT_AUDIT_METADATA_KEYS[action] ?? []
  const src = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of allowed) {
    const v = src[key]
    if (key === 'ids') {
      if (Array.isArray(v)) {
        out.ids = v
          .filter((x): x is string => typeof x === 'string' && x.length <= 64)
          .slice(0, CLIENT_AUDIT_IDS_MAX)
      }
    } else if (typeof v === 'string') {
      out[key] = v.slice(0, CLIENT_AUDIT_STRING_MAX)
    } else if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) {
      out[key] = v
    }
  }
  return out
}

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
