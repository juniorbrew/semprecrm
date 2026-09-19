import type { AccountRole } from "@/lib/auth/roles";
import type { LimitKey, OptionalModule, Plan, PlanStatus } from "@/lib/plans";

export interface Profile {
  id: string;
  user_id: string;
  full_name: string;
  email: string;
  avatar_url?: string;
  /**
   * Legacy free-form role column from migration 001. Never read
   * by the app since 017_account_sharing.sql introduced the typed
   * `account_role` enum. Flagged for removal in a later cleanup
   * migration — kept on the type so existing destructures don't
   * break.
   */
  role: string;
  /**
   * Opted-in beta feature keys for this account. The column survives
   * for future beta gates; no current feature reads it (Flows was
   * the last user and went to soft-GA in PR #134). Defaults to `[]`
   * for every profile; toggled per-account via a direct UPDATE on
   * the `profiles` row.
   */
  beta_features?: string[];
  /**
   * Account this profile is a member of. Added by
   * `017_account_sharing.sql`; NOT NULL in the DB post-backfill.
   * Optional on the type only because older serialised payloads
   * (cached client state, test fixtures) may not have it yet.
   */
  account_id?: string;
  /**
   * Caller's role within their account. Source of truth for every
   * role-gated UI / API check — call `hasMinRole` from
   * `@/lib/auth/roles` rather than comparing this string directly.
   */
  account_role?: AccountRole;
  /** "Disponível / Ausente" (migration 033). Defaults to 'available'. */
  availability?: Availability;
  /**
   * Push toggles per event kind (migration 036). Read through
   * `parseNotificationPrefs` in `@/lib/push/prefs` — a missing key is ON.
   */
  notification_prefs?: Record<string, unknown> | null;
  created_at: string;
}

// ============================================================
// Account-sharing entities (017_account_sharing.sql)
// ============================================================

export interface Account {
  id: string;
  name: string;
  /** auth.users.id of the immutable owner. */
  owner_user_id: string;
  /** Default deal currency (ISO-4217). Migration 021. */
  default_currency?: string;
  /** Registration (042): 'pf' = pessoa física (CPF), 'pj' = pessoa jurídica (CNPJ). */
  person_type?: 'pf' | 'pj';
  /** CPF (11 digits) or CNPJ (14 alphanumerics), no mask. */
  tax_id?: string | null;
  /** Razão social — pessoa jurídica only. */
  legal_name?: string | null;
  /** Contact block (043): digits-only phone, company e-mail, address jsonb. */
  phone?: string | null;
  email?: string | null;
  address?: Record<string, unknown> | null;
  // ---- Plan / platform fields (025_plans_and_platform_admin.sql) ----
  /** Catalogue key — see `PLAN_CATALOG` in `@/lib/plans`. */
  plan: Plan;
  plan_status: PlanStatus;
  /** ISO timestamp; null = no expiry. Trial accounts get now()+14d at signup. */
  plan_expires_at: string | null;
  /** Per-module override, e.g. `{ flows: true, broadcasts: false }`. */
  module_overrides: Partial<Record<OptionalModule, boolean>>;
  /** Per-limit override, e.g. `{ max_users: 5 }`; null = unlimited. */
  limit_overrides: Partial<Record<LimitKey, number | null>>;
  /** Platform-admin notes. Never shown to the customer. */
  platform_notes: string | null;
  /**
   * Free-form per-account settings (migration 030). Read through
   * `parseAccountPreferences` in `@/lib/account-preferences`, which
   * fills defaults — never index this raw.
   */
  preferences?: Partial<AccountPreferences> | null;
  /**
   * White-label branding (migration 037): `{ app_name, logo_url,
   * primary_color }`. Read through `parseBranding` in `@/lib/branding`.
   */
  branding?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/**
 * Typed keys of `accounts.preferences`. Defaults live in
 * `@/lib/account-preferences` (`DEFAULT_ACCOUNT_PREFERENCES`).
 */
export interface AccountPreferences {
  /** Minutes a customer may wait for a reply before the Radar flags it. */
  inbox_sla_minutes: number;
  /** Hours since the last agent message before a conversation is "cooling". */
  cooling_hours: number;
  /** Whole-message stop words (compared accent- and case-insensitively). */
  opt_out_keywords: string[];
  /** Business hours per weekday (migration 033). See `@/lib/business-hours`. */
  business_hours: BusinessHours;
  /** Send `out_of_hours_message` when a customer writes outside business hours. */
  out_of_hours_enabled: boolean;
  out_of_hours_message: string;
  /** Round-robin the first customer message of an unassigned conversation. */
  auto_assign_enabled: boolean;
  /** Owners/admins must have a verified TOTP factor (round 2 spec, section 7). */
  require_mfa_admins: boolean;
}

/** `"HH:MM"` 24h local time. */
export type BusinessHoursRange = { start: string; end: string };
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export interface BusinessHours {
  /** IANA timezone, e.g. "America/Sao_Paulo". */
  timezone: string;
  /** Up to two ranges per day; an empty array means closed that day. */
  days: Record<Weekday, BusinessHoursRange[]>;
}

/** `profiles.availability` (migration 033). */
export type Availability = 'available' | 'away';

/**
 * One row of `platform_list_accounts()` — an `Account` plus the
 * owner's identity and the counts the /platform table shows.
 */
export interface PlatformAccountRow extends Account {
  owner_email: string | null;
  owner_name: string | null;
  members_count: number;
  channels_count: number;
  pending_invites_count: number;
}

/** `user_id` listed in `platform_admins` = platform (master) admin. */
export interface PlatformAdmin {
  user_id: string;
  created_at: string;
}

/**
 * Hydrated member row for the Settings → Members tab. Combines
 * the profile and its account_role for a single member of the
 * caller's account. Sensitive fields (email) are populated only
 * when the caller has admin+ — agents and viewers see name +
 * avatar + role only.
 */
export interface AccountMember {
  user_id: string;
  full_name: string;
  email: string | null;
  avatar_url: string | null;
  role: AccountRole;
  joined_at: string;
  /** Migration 033 — absent on older payloads (treat as 'available'). */
  availability?: Availability;
}

/**
 * Outstanding invite link row. `token_hash` is intentionally
 * absent — it lives only in the DB and on the server. The
 * plaintext token is returned once at creation time and surfaced
 * via the invite URL; never re-emitted.
 */
export interface AccountInvitation {
  id: string;
  account_id: string;
  /** Roles offered via invite — owner is never offered. */
  role: Exclude<AccountRole, "owner">;
  created_by_user_id: string | null;
  label: string | null;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_by_user_id: string | null;
}

export interface Contact {
  id: string;
  user_id: string;
  account_id: string;
  phone: string;
  /** Digits-only form of `phone`, generated by the DB (migration 022)
   *  and unique per account. Read-only. */
  phone_normalized?: string;
  name?: string;
  email?: string;
  company?: string;
  avatar_url?: string;
  /**
   * Set when the customer asked to stop receiving messages ("PARAR")
   * — migration 030. Automations skip send steps and broadcasts drop
   * the contact while this is set; admin+ can clear it ("Reativar").
   */
  opted_out_at?: string | null;
  /** LGPD consent (migration 035). `consent_updated_at` is stamped by a trigger. */
  consent_status?: ConsentStatus;
  consent_updated_at?: string | null;
  /**
   * Set by POST /api/contacts/[id]/anonymize (migration 035). Personal
   * data is gone; the UI shows a badge and blocks editing / sending.
   */
  anonymized_at?: string | null;
  created_at: string;
  updated_at: string;
}

/** `contacts.consent_status` (migration 035). */
export type ConsentStatus = 'unknown' | 'granted' | 'revoked';

export interface Tag {
  id: string;
  user_id: string;
  name: string;
  color: string;
  created_at: string;
}

export interface ContactTag {
  id: string;
  contact_id: string;
  tag_id: string;
}

export interface CustomField {
  id: string;
  user_id: string;
  /** Tenancy key — NOT NULL since migration 017. */
  account_id: string;
  field_name: string;
  field_type: string;
  field_options?: Record<string, unknown>;
  created_at: string;
}

export interface ContactCustomValue {
  id: string;
  contact_id: string;
  custom_field_id: string;
  value?: string;
}

export interface ContactNote {
  id: string;
  contact_id: string;
  user_id: string;
  note_text: string;
  created_at: string;
}

export type ConversationStatus = 'open' | 'pending' | 'closed';

/**
 * Which WhatsApp transport a conversation / message went through.
 * `official` = Meta Cloud API (webhook + templates), `qr` = the
 * WhatsApp Web session held by `services/wa-gateway` (migration 026).
 */
export type WhatsAppChannel = 'official' | 'qr';

export interface Conversation {
  id: string;
  user_id: string;
  contact_id: string;
  status: ConversationStatus;
  /** Defaults to 'official' on rows that predate migration 026. */
  channel?: WhatsAppChannel;
  assigned_agent_id?: string;
  last_message_text?: string;
  last_message_at?: string;
  /**
   * Kept by the `messages` AFTER INSERT trigger (migration 030): the
   * newest customer message / newest agent-or-bot message. Drive the
   * Radar (waiting / cooling) and the `conversation_inactive` trigger.
   */
  last_customer_message_at?: string | null;
  last_agent_message_at?: string | null;
  unread_count: number;
  created_at: string;
  updated_at: string;
  contact?: Contact;
}

export type SenderType = 'customer' | 'agent' | 'bot';
export type ContentType =
  | 'text'
  | 'image'
  | 'document'
  | 'audio'
  | 'video'
  | 'location'
  | 'template'
  /** Customer tapped a reply button or list row on a message we sent. */
  | 'interactive';
export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface Message {
  id: string;
  conversation_id: string;
  sender_type: SenderType;
  sender_id?: string;
  content_type: ContentType;
  content_text?: string;
  media_url?: string;
  template_name?: string;
  message_id?: string;
  status: MessageStatus;
  /** Transport the message went through; 'official' when absent. */
  channel?: WhatsAppChannel;
  created_at: string;
  reply_to_message_id?: string;
  /**
   * Only set when `content_type === 'interactive'` — the stable id of
   * the button or list row the customer tapped. The Flows engine uses
   * this to route the next node; the inbox bubble uses it as a styling
   * cue (renders with a "↩ button reply" affordance).
   */
  interactive_reply_id?: string;
}

export type ReactionActor = 'customer' | 'agent';

export interface MessageReaction {
  id: string;
  message_id: string;
  conversation_id: string;
  actor_type: ReactionActor;
  actor_id?: string;
  emoji: string;
  created_at: string;
}

/** `conversation_events.event_type` — closed list enforced by a CHECK. */
export type ConversationEventType =
  | 'assigned'
  | 'unassigned'
  | 'status_changed'
  | 'label_added'
  | 'label_removed'
  | 'note_added'
  /** Contact opt-out (migration 030): customer sent a stop word / admin reactivated. */
  | 'contact_opted_out'
  | 'contact_opted_in';

/**
 * Type-specific details stored in `conversation_events.payload`.
 * `actor_name` is a display snapshot taken when the row was written;
 * the client prefers the live profile name when it has one.
 */
export interface ConversationEventPayload {
  actor_name?: string;
  /** `assigned` */
  assignee_user_id?: string;
  assignee_name?: string;
  self_assigned?: boolean;
  /** `status_changed` */
  status?: ConversationStatus;
  previous_status?: ConversationStatus;
  /** `label_added` / `label_removed` */
  tag_id?: string;
  tag_name?: string;
  /** `note_added` */
  note_id?: string;
  /** `contact_opted_out` — the normalised stop word that triggered it. */
  keyword?: string;
}

/** Row of `conversation_events` (migration 024). */
export interface ConversationEventRecord {
  id: string;
  account_id: string;
  conversation_id: string;
  actor_user_id?: string | null;
  event_type: ConversationEventType;
  payload: ConversationEventPayload;
  created_at: string;
}

export interface WhatsAppConfig {
  id: string;
  user_id: string;
  phone_number_id: string;
  waba_id?: string;
  access_token: string;
  verify_token?: string;
  status: 'connected' | 'disconnected';
  connected_at?: string;
  /**
   * Set when POST /{phone_number_id}/register last succeeded. NULL
   * means the number was saved but never actually subscribed for
   * webhooks on Meta's side — inbound events will be silently lost.
   */
  registered_at?: string;
  /** Set when POST /{waba_id}/subscribed_apps last succeeded. */
  subscribed_apps_at?: string;
  /** Last error from /register; cleared on success. */
  last_registration_error?: string;
}

export type WaQrSessionStatus = 'disconnected' | 'qr' | 'connecting' | 'connected';

/** One row per account — mirrors the gateway's session state (migration 026). */
export interface WaQrSession {
  account_id: string;
  status: WaQrSessionStatus;
  phone_number?: string | null;
  display_name?: string | null;
  connected_at?: string | null;
  last_error?: string | null;
  updated_at: string;
}

// Raw Meta status enum. We persist this verbatim from Meta (sync + webhook)
// rather than collapsing to a local TitleCase set — distinctions like
// PAUSED vs DISABLED vs IN_APPEAL drive the edit/resubmit/delete flows.
// DRAFT is the local-only state before the row is submitted to Meta.
export type MessageTemplateStatus =
  | 'DRAFT'
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'PAUSED'
  | 'DISABLED'
  | 'IN_APPEAL'
  | 'PENDING_DELETION';

export type TemplateButton =
  | { type: 'QUICK_REPLY'; text: string }
  | { type: 'URL'; text: string; url: string; example?: string }
  | { type: 'PHONE_NUMBER'; text: string; phone_number: string }
  | { type: 'COPY_CODE'; text: string; example: string };

export interface TemplateSampleValues {
  body?: string[];
  header?: string[];
}

export interface MessageTemplate {
  id: string;
  user_id: string;
  name: string;
  category: 'Marketing' | 'Utility' | 'Authentication';
  language?: string;
  header_type?: 'text' | 'image' | 'video' | 'document';
  header_content?: string;
  header_handle?: string;
  header_media_url?: string;
  body_text: string;
  footer_text?: string;
  buttons?: TemplateButton[];
  sample_values?: TemplateSampleValues;
  status?: MessageTemplateStatus;
  meta_template_id?: string;
  rejection_reason?: string;
  quality_score?: 'GREEN' | 'YELLOW' | 'RED';
  submission_error?: string;
  last_submitted_at?: string;
  created_at: string;
}

export interface Pipeline {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
}

export interface PipelineStage {
  id: string;
  pipeline_id: string;
  name: string;
  position: number;
  color: string;
  created_at: string;
}

export type DealStatus = 'open' | 'won' | 'lost';

/** A reason a deal can be lost for — per account, ordered, activatable
 *  (migration 031). Seeded with five defaults on signup. */
export interface DealLossReason {
  id: string;
  account_id: string;
  name: string;
  position: number;
  is_active: boolean;
  created_at: string;
}

export interface Deal {
  id: string;
  user_id: string;
  pipeline_id: string;
  stage_id: string;
  /**
   * Nullable after migration 004 — becomes NULL when the referenced
   * contact is deleted (ON DELETE SET NULL). History preserved.
   */
  contact_id: string | null;
  conversation_id?: string;
  assigned_to?: string;
  title: string;
  value: number;
  currency?: string;
  notes?: string;
  expected_close_date?: string;
  status?: DealStatus;
  /** Why the deal was lost (migration 031). Cleared on reopen / won. */
  loss_reason_id?: string | null;
  lost_note?: string | null;
  created_at: string;
  updated_at?: string;
  contact?: Contact;
  stage?: PipelineStage;
  assignee?: Profile;
  loss_reason?: Pick<DealLossReason, 'id' | 'name'> | null;
}

export type BroadcastStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed';
export type RecipientStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'replied' | 'failed';

export interface Broadcast {
  id: string;
  user_id: string;
  name: string;
  template_name: string;
  template_language: string;
  template_variables?: Record<string, unknown>;
  audience_filter?: Record<string, unknown>;
  scheduled_at?: string;
  status: BroadcastStatus;
  total_recipients: number;
  sent_count: number;
  delivered_count: number;
  read_count: number;
  replied_count: number;
  failed_count: number;
  created_at: string;
}

export interface BroadcastRecipient {
  id: string;
  broadcast_id: string;
  /**
   * Nullable after migration 004 — becomes NULL when the referenced
   * contact is deleted (ON DELETE SET NULL). History preserved; the
   * UI renders "Unknown" for orphaned rows.
   */
  contact_id: string | null;
  status: RecipientStatus;
  sent_at?: string;
  delivered_at?: string;
  read_at?: string;
  replied_at?: string;
  error_message?: string;
  /**
   * Meta's message id, persisted when the broadcast send succeeds so
   * the webhook can mirror status updates back onto the recipient row.
   * Added in migration 003.
   */
  whatsapp_message_id?: string;
  created_at: string;
  contact?: Contact;
}

// ============================================================
// Automations (migration 006)
// ============================================================

export type AutomationTriggerType =
  | 'new_message_received'
  | 'first_inbound_message'
  | 'keyword_match'
  | 'new_contact_created'
  | 'conversation_assigned'
  | 'tag_added'
  | 'time_based'
  | 'lead_captured'
  /** Conversation silent for N hours (migration 030) — fired by the cron scan. */
  | 'conversation_inactive';

export type AutomationStepType =
  | 'send_message'
  | 'send_template'
  | 'add_tag'
  | 'remove_tag'
  | 'assign_conversation'
  | 'update_contact_field'
  | 'create_deal'
  | 'wait'
  | 'condition'
  | 'send_webhook'
  | 'close_conversation'
  | 'create_task';

export type AutomationLogStatus = 'success' | 'partial' | 'failed';

export interface KeywordMatchTriggerConfig {
  keywords: string[];
  match_type: 'exact' | 'contains';
  case_sensitive?: boolean;
}

export interface TagTriggerConfig {
  tag_id: string;
}

export interface TimeBasedTriggerConfig {
  /** Cron expression or simple HH:mm string; engine can accept either. */
  schedule: string;
  timezone?: string;
}

/** `lead_captured` (migration 029): fire for every source, or only one. */
export interface LeadCapturedTriggerConfig {
  source_id?: string;
}

/**
 * `conversation_inactive` (migration 030): fire once per silence when a
 * conversation in one of `statuses` has had no message for `hours`
 * (decimal allowed, 0.05–720) and the last message came from `last_from`.
 */
export interface ConversationInactiveTriggerConfig {
  hours: number;
  last_from: 'agent' | 'customer' | 'any';
  statuses: ('open' | 'pending')[];
}

export type AutomationTriggerConfig =
  | Record<string, never>
  | KeywordMatchTriggerConfig
  | TagTriggerConfig
  | TimeBasedTriggerConfig
  | LeadCapturedTriggerConfig
  | ConversationInactiveTriggerConfig
  | Record<string, unknown>;

export interface SendMessageStepConfig {
  text: string;
}

export interface SendTemplateStepConfig {
  template_name: string;
  language?: string;
  variables?: Record<string, string>;
}

export interface TagStepConfig {
  tag_id: string;
}

export interface AssignConversationStepConfig {
  mode: 'specific' | 'round_robin';
  agent_id?: string;
}

export interface UpdateContactFieldStepConfig {
  /**
   * Either a built-in contact column (`name` | `email` | `company`) or a
   * custom field encoded as `custom:<custom_field_id>`. The `custom:` prefix
   * is how the engine distinguishes a `contact_custom_values` write from a
   * direct `contacts` column update. Older configs store the bare column name,
   * so this stays backward compatible.
   */
  field: string;
  /** Supports `{{ vars.* }}` / `{{ message.text }}` interpolation at runtime. */
  value: string;
}

export interface CreateDealStepConfig {
  pipeline_id: string;
  stage_id: string;
  title: string;
  value?: number;
}

export interface WaitStepConfig {
  amount: number;
  unit: 'minutes' | 'hours' | 'days';
}

/**
 * `create_task` — inserts a row in `tasks` (migration 027) linked to
 * the triggering contact + conversation, on the account's default open
 * status. `title` / `description` accept `{{ contact.name }}`,
 * `{{ contact.phone }}`, `{{ message.text }}` and `{{ vars.* }}`.
 */
export interface CreateTaskStepConfig {
  title: string;
  description?: string;
  /** Defaults to 'normal'. */
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  /** Account member to assign; unassigned when empty. */
  assignee_user_id?: string;
  /** Due date = run time + this many hours; no due date when empty. */
  due_in_hours?: number;
}

export type ConditionSubject =
  | 'contact_field'
  | 'tag_presence'
  | 'message_content'
  | 'time_of_day';

export interface ConditionStepConfig {
  subject: ConditionSubject;
  /** e.g. field name, tag id, substring, or "HH:mm-HH:mm" depending on subject */
  operand?: string;
  /** For contact_field equals / message_content contains — comparison value */
  value?: string;
}

export interface SendWebhookStepConfig {
  url: string;
  headers?: Record<string, string>;
  body_template?: string;
}

export type AutomationStepConfig =
  | SendMessageStepConfig
  | SendTemplateStepConfig
  | TagStepConfig
  | AssignConversationStepConfig
  | UpdateContactFieldStepConfig
  | CreateDealStepConfig
  | WaitStepConfig
  | ConditionStepConfig
  | SendWebhookStepConfig
  | CreateTaskStepConfig
  | Record<string, never>
  | Record<string, unknown>;

export interface Automation {
  id: string;
  /** Account tenancy key — every automation belongs to one account
   *  (migration 017 made the column NOT NULL). The engine looks up
   *  active automations by this field on inbound webhook events. */
  account_id: string;
  /** Original author. Used for log audit + outbound message
   *  sender-of-record, never for tenancy isolation. */
  user_id: string;
  name: string;
  description?: string;
  trigger_type: AutomationTriggerType;
  trigger_config: AutomationTriggerConfig;
  is_active: boolean;
  execution_count: number;
  last_executed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface AutomationStep {
  id: string;
  automation_id: string;
  parent_step_id?: string | null;
  branch?: 'yes' | 'no' | null;
  step_type: AutomationStepType;
  step_config: AutomationStepConfig;
  position: number;
  created_at: string;
}

export interface AutomationLogStepResult {
  step_id: string;
  step_type: AutomationStepType;
  status: 'success' | 'skipped' | 'failed';
  detail?: string;
}

export interface AutomationLog {
  id: string;
  automation_id: string;
  user_id: string;
  contact_id: string | null;
  trigger_event: string;
  steps_executed: AutomationLogStepResult[];
  status: AutomationLogStatus;
  error_message?: string | null;
  created_at: string;
  contact?: Contact;
}

// ============================================================
// Quick replies (migration 028) — per-account canned responses
// inserted from the inbox composer via "/atalho". `body` may hold
// {{contato.nome}}, {{contato.primeiro_nome}}, {{atendente.nome}},
// {{empresa}} — resolved by src/lib/quick-replies/render.ts.
// ============================================================
export interface QuickReply {
  id: string;
  account_id: string;
  /** Lower-case, no spaces, unique per account (^[a-z0-9_-]{1,30}$). */
  shortcut: string;
  title: string;
  body: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Lead capture by webhook (migration 029) — one public endpoint per
// source (`/api/v1/webhooks/in/<token>`) that turns a payload into
// contact + deal + tags. Logic in src/lib/lead-capture/.
// ============================================================

/**
 * Which payload key feeds each CRM field. Missing keys fall back to
 * the defaults (`name`, `phone`, `email`, `company`). Values may be
 * dotted paths (`lead.telefone`). `custom` maps custom_field_id →
 * payload key.
 */
export interface LeadSourceFieldMap {
  name?: string;
  phone?: string;
  email?: string;
  company?: string;
  custom?: Record<string, string>;
}

export interface LeadSource {
  id: string;
  account_id: string;
  name: string;
  /** 32 random bytes, hex — generated server-side. Admin-only on the client. */
  token: string;
  is_active: boolean;
  pipeline_id: string | null;
  stage_id: string | null;
  tag_ids: string[];
  assignee_user_id: string | null;
  field_map: LeadSourceFieldMap;
  received_count: number;
  last_received_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export type LeadSourceEventStatus = 'ok' | 'duplicate' | 'error';

export interface LeadSourceEvent {
  id: string;
  account_id: string;
  source_id: string;
  status: LeadSourceEventStatus;
  error: string | null;
  contact_id: string | null;
  deal_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
  contact?: Pick<Contact, 'id' | 'name' | 'phone'> | null;
}

// ============================================================
// Internal team chat (migrations 038 + 039) — direct and group
// threads between members of the same account, with delivery /
// read receipts (per member on groups), presence, attachments,
// reactions and edit / delete. Logic in src/lib/chat/.
// ============================================================

export type ChatThreadKind = 'direct' | 'group';

/** `text` = a person wrote it; `system` = group event (JSON body, see ChatSystemEvent). */
export type ChatMessageKind = 'text' | 'system';

/** Attachment stored on a message (object in the private `chat-internal` bucket). */
export interface ChatAttachment {
  /** Object path: `account-<id>/chat/<thread>/<uuid>-<name>`. */
  path: string;
  /** Original file name (shown on the document chip / download). */
  name: string;
  mime: string;
  /** Bytes. */
  size: number;
  width?: number;
  height?: number;
  /** Seconds (audio / video). */
  duration?: number;
}

/** Body of a `kind: 'system'` message, stored as JSON text. */
export type ChatSystemEvent =
  | { event: 'created' }
  | { event: 'added'; users: string[] }
  | { event: 'removed'; users: string[] }
  | { event: 'left' };

/** Per-member receipt on a group message (`chat_message_receipts`). */
export interface ChatMessageReceipt {
  message_id: string;
  user_id: string;
  thread_id: string | null;
  delivered_at: string | null;
  read_at: string | null;
}

/** One emoji from one user on one message (`chat_message_reactions`). */
export interface ChatMessageReaction {
  message_id: string;
  user_id: string;
  emoji: string;
  thread_id: string | null;
  created_at: string;
}

export interface ChatThread {
  id: string;
  account_id: string;
  kind: ChatThreadKind;
  /** Groups only (phase 2). */
  title: string | null;
  created_by: string | null;
  /** Ordered pair (a < b) on direct threads; null on groups. */
  direct_user_a: string | null;
  direct_user_b: string | null;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  /** Embedded `chat_thread_members` rows when selected with the thread. */
  members?: ChatThreadMember[];
}

export interface ChatThreadMember {
  thread_id: string;
  user_id: string;
  joined_at: string;
  last_read_at: string | null;
}

export interface ChatMessage {
  id: string;
  account_id: string;
  thread_id: string;
  sender_id: string;
  /** Empty when the message is only an attachment or was deleted. */
  body: string;
  kind: ChatMessageKind;
  created_at: string;
  /** Direct threads: stamped by the recipient's client when the row reaches it. */
  delivered_at: string | null;
  /** Direct threads: stamped by the recipient when the thread is open and visible. */
  read_at: string | null;
  /** Set by the sender's edit (allowed for 15 minutes after `created_at`). */
  edited_at: string | null;
  /** Set by the sender's delete — body emptied, attachment removed. */
  deleted_at: string | null;
  attachment: ChatAttachment | null;
}

/** Sent → delivered → read, derived from the receipt columns. */
export type ChatMessageStatus = 'sent' | 'delivered' | 'read';

/** An account member as the chat lists them (profiles projection). */
export interface ChatMember {
  user_id: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
  /** Presence heartbeat fallback — "last seen X ago" when offline. */
  last_seen_at: string | null;
}

// ============================================================
// Calendar (migration 040, module `calendar`) — appointments owned
// by a member, with attendees and optional links to a contact, an
// inbox conversation, a deal, a task and an internal chat thread.
// Everything is stored in UTC; the account timezone
// (`preferences.business_hours.timezone`) is applied by the UI.
// Logic in src/lib/calendar/.
// ============================================================

export type CalendarEventStatus = 'confirmed' | 'cancelled';

/** Where an event came from: created here, or imported from a provider (migration 041). */
export type CalendarEventSource = 'internal' | 'google' | 'microsoft';

/** External calendar providers (migration 041). */
export type CalendarProvider = 'google' | 'microsoft';

export type CalendarConnectionStatus = 'active' | 'error' | 'revoked';

/**
 * `calendar_connections_public` — one row per (user, provider) as the
 * owner sees it (no tokens). The base table holds the encrypted
 * tokens and is only reachable with the service role.
 */
export interface CalendarConnectionPublic {
  id: string;
  account_id: string;
  user_id: string;
  provider: CalendarProvider;
  email: string | null;
  external_calendar_id: string | null;
  token_expires_at: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  status: CalendarConnectionStatus;
  /** Also mirror appointments where the user is an attendee. */
  mirror_attending: boolean;
  created_at: string;
  updated_at: string;
}

/** Full `calendar_connections` row — service role only (sync engine, OAuth routes). */
export interface CalendarConnection extends CalendarConnectionPublic {
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  /** Google `syncToken` / Graph `deltaLink` (see migration 041). */
  sync_cursor: string | null;
}

export type CalendarAttendeeResponse = 'needs_action' | 'accepted' | 'declined';

export interface CalendarEventAttendee {
  event_id: string;
  user_id: string;
  response: CalendarAttendeeResponse;
}

/** Minimal projections embedded on an event row. */
export interface CalendarContactRef {
  id: string;
  name: string | null;
  phone: string;
  avatar_url: string | null;
}

export interface CalendarDealRef {
  id: string;
  title: string;
  pipeline_id: string;
}

export interface CalendarTaskRef {
  id: string;
  title: string;
}

export interface CalendarChatThreadRef {
  id: string;
  kind: ChatThreadKind;
  title: string | null;
}

export interface CalendarEvent {
  id: string;
  account_id: string;
  owner_user_id: string | null;
  title: string;
  description: string | null;
  location: string | null;
  /** Hex colour chosen on the event; null = the owner's palette colour. */
  color: string | null;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  status: CalendarEventStatus;
  /** 5, 10, 15, 30, 60 or 1440 — null = no reminder. */
  reminder_minutes: number | null;
  reminded_at: string | null;
  contact_id: string | null;
  conversation_id: string | null;
  deal_id: string | null;
  task_id: string | null;
  chat_thread_id: string | null;
  source: CalendarEventSource;
  external_connection_id: string | null;
  external_id: string | null;
  external_etag: string | null;
  external_updated_at: string | null;
  sync_hash: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** Embedded by `EVENT_SELECT` (src/lib/calendar/queries.ts). */
  attendees?: CalendarEventAttendee[];
  contact?: CalendarContactRef | null;
  deal?: CalendarDealRef | null;
  task?: CalendarTaskRef | null;
  chat_thread?: CalendarChatThreadRef | null;
}
