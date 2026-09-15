// ============================================================
// Plans, modules and entitlement resolution — pure, no I/O.
//
// The DB (migration 025) stores only the plan name, its status,
// an optional expiry and two per-account override objects. What
// each plan actually grants lives here so a catalogue change is a
// code change (reviewable, testable) rather than a data migration.
//
// `resolveEntitlements` is the single place that turns an account
// row into "which modules are on, which limits apply, is the app
// blocked". Both the client hook (`useEntitlements`) and every
// server guard call it, so the rule can never drift between the
// sidebar and the API.
// ============================================================

export const PLANS = ['trial', 'basico', 'pro', 'empresa'] as const;
export type Plan = (typeof PLANS)[number];

export const PLAN_STATUSES = [
  'trial',
  'active',
  'past_due',
  'canceled',
  'suspended',
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/**
 * Every module the app knows about. `inbox` and `contacts` are
 * always on (forced by `resolveEntitlements`); the rest are plan-
 * dependent and overridable per account by the platform admin.
 */
export const MODULES = [
  'inbox',
  'contacts',
  'dashboard',
  'pipelines',
  'tasks',
  'broadcasts',
  'automations',
  'flows',
  'channel_official',
  'channel_qr',
  'lead_capture',
  'white_label',
] as const;
export type Module = (typeof MODULES)[number];

/** Modules that can be toggled by plan / override. */
export const OPTIONAL_MODULES = [
  'dashboard',
  'pipelines',
  'tasks',
  'broadcasts',
  'automations',
  'flows',
  'channel_official',
  'channel_qr',
  'lead_capture',
  'white_label',
] as const satisfies readonly Module[];
export type OptionalModule = (typeof OPTIONAL_MODULES)[number];

/** Modules that are always on regardless of plan or overrides. */
export const ALWAYS_ON_MODULES = ['inbox', 'contacts'] as const satisfies readonly Module[];

export const LIMIT_KEYS = ['max_users', 'max_channels'] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

/** `null` = unlimited. */
export type Limits = Record<LimitKey, number | null>;

export interface PlanDefinition {
  /** Optional modules granted by the plan (always-on ones implied). */
  modules: readonly OptionalModule[];
  limits: Limits;
}

const ALL_OPTIONAL: readonly OptionalModule[] = OPTIONAL_MODULES;

/**
 * The plan catalogue. Source of truth: the spec table.
 *
 * | plan    | módulos                          | max_users | max_channels |
 * |---------|----------------------------------|-----------|--------------|
 * | trial   | todos                            | 2         | 1            |
 * | basico  | dashboard, pipelines, tasks, channel_qr | 3   | 1            |
 * | pro     | todos menos flows                | 10        | 2            |
 * (`lead_capture` — webhook lead capture, migration 029 — and
 *  `white_label` — own branding, migration 037 — are in every plan
 *  except basico.)
 * | empresa | todos                            | null      | 5            |
 */
export const PLAN_CATALOG: Record<Plan, PlanDefinition> = {
  trial: {
    modules: ALL_OPTIONAL,
    limits: { max_users: 2, max_channels: 1 },
  },
  basico: {
    modules: ['dashboard', 'pipelines', 'tasks', 'channel_qr'],
    limits: { max_users: 3, max_channels: 1 },
  },
  pro: {
    modules: ALL_OPTIONAL.filter((m) => m !== 'flows'),
    limits: { max_users: 10, max_channels: 2 },
  },
  empresa: {
    modules: ALL_OPTIONAL,
    limits: { max_users: null, max_channels: 5 },
  },
};

/** Human labels — English keys go through the i18n catalogue. */
export const PLAN_LABELS: Record<Plan, string> = {
  trial: 'Trial',
  basico: 'Basic',
  pro: 'Pro',
  empresa: 'Enterprise',
};

export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  trial: 'Trial',
  active: 'Active',
  past_due: 'Past due',
  canceled: 'Canceled',
  suspended: 'Suspended',
};

export const MODULE_LABELS: Record<Module, string> = {
  inbox: 'Inbox',
  contacts: 'Contacts',
  dashboard: 'Dashboard',
  pipelines: 'Pipelines',
  tasks: 'Tasks',
  broadcasts: 'Broadcasts',
  automations: 'Automations',
  flows: 'Flows',
  channel_official: 'Official WhatsApp API',
  channel_qr: 'WhatsApp via QR code',
  lead_capture: 'Lead capture (webhook)',
  white_label: 'White-label branding',
};

export const LIMIT_LABELS: Record<LimitKey, string> = {
  max_users: 'Max users',
  max_channels: 'Max channels',
};

// ------------------------------------------------------------
// Type guards
// ------------------------------------------------------------

export function isPlan(value: unknown): value is Plan {
  return typeof value === 'string' && (PLANS as readonly string[]).includes(value);
}

export function isPlanStatus(value: unknown): value is PlanStatus {
  return (
    typeof value === 'string' &&
    (PLAN_STATUSES as readonly string[]).includes(value)
  );
}

export function isModule(value: unknown): value is Module {
  return typeof value === 'string' && (MODULES as readonly string[]).includes(value);
}

export function isOptionalModule(value: unknown): value is OptionalModule {
  return (
    typeof value === 'string' &&
    (OPTIONAL_MODULES as readonly string[]).includes(value)
  );
}

export function isLimitKey(value: unknown): value is LimitKey {
  return typeof value === 'string' && (LIMIT_KEYS as readonly string[]).includes(value);
}

// ------------------------------------------------------------
// Entitlement resolution
// ------------------------------------------------------------

/**
 * The subset of an `accounts` row the resolver reads. Every field
 * is tolerant of `undefined` / `null` so a row from a fork running
 * a pre-025 schema resolves to the trial defaults instead of
 * crashing.
 */
export interface PlanAccountFields {
  plan?: string | null;
  plan_status?: string | null;
  plan_expires_at?: string | Date | null;
  module_overrides?: Record<string, unknown> | null;
  limit_overrides?: Record<string, unknown> | null;
}

export type BlockReason =
  | 'past_due'
  | 'canceled'
  | 'suspended'
  | 'trial_expired';

export interface Entitlements {
  plan: Plan;
  status: PlanStatus;
  /** ISO string or null (no expiry). */
  expiresAt: string | null;
  modules: Record<Module, boolean>;
  limits: Limits;
  blocked: false | { reason: BlockReason };
}

function toIso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Resolve an account row into concrete entitlements.
 *
 * Rule (from the spec): start from the plan, apply `module_overrides`
 * and `limit_overrides`, force `inbox` + `contacts` on, then derive
 * `blocked` from `plan_status` and `plan_expires_at`.
 *
 * Unknown plan / status values fall back to `trial` (the most
 * permissive-but-limited tier) so a bad row degrades to "trial
 * behaviour" rather than locking a customer out or granting
 * everything.
 *
 * `now` is injectable for tests.
 */
export function resolveEntitlements(
  account: PlanAccountFields | null | undefined,
  now: Date = new Date(),
): Entitlements {
  const plan: Plan = isPlan(account?.plan) ? account.plan : 'trial';
  const status: PlanStatus = isPlanStatus(account?.plan_status)
    ? account.plan_status
    : 'trial';
  const def = PLAN_CATALOG[plan];

  // 1. Plan baseline.
  const modules = Object.fromEntries(
    MODULES.map((m) => [m, false]),
  ) as Record<Module, boolean>;
  for (const m of def.modules) modules[m] = true;
  const limits: Limits = { ...def.limits };

  // 2. Overrides (only known keys, only well-typed values).
  const mo = account?.module_overrides;
  if (mo && typeof mo === 'object') {
    for (const [key, value] of Object.entries(mo)) {
      if (isOptionalModule(key) && typeof value === 'boolean') {
        modules[key] = value;
      }
    }
  }
  const lo = account?.limit_overrides;
  if (lo && typeof lo === 'object') {
    for (const [key, value] of Object.entries(lo)) {
      if (!isLimitKey(key)) continue;
      if (value === null) {
        limits[key] = null;
      } else if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        limits[key] = Math.floor(value);
      }
    }
  }

  // 3. Always-on modules — overrides can never switch these off.
  for (const m of ALWAYS_ON_MODULES) modules[m] = true;

  // 4. Blocking.
  const expiresAt = toIso(account?.plan_expires_at);
  let blocked: Entitlements['blocked'] = false;
  if (status === 'past_due' || status === 'canceled' || status === 'suspended') {
    blocked = { reason: status };
  } else if (
    status === 'trial' &&
    expiresAt !== null &&
    new Date(expiresAt).getTime() <= now.getTime()
  ) {
    blocked = { reason: 'trial_expired' };
  }

  return { plan, status, expiresAt, modules, limits, blocked };
}

// ------------------------------------------------------------
// Limit helpers — shared by the API routes and their tests.
// ------------------------------------------------------------

/**
 * Whether one more user (member or invite) fits under `max_users`.
 * Pending invites count against the limit so an admin can't
 * pre-issue ten links on a two-seat plan.
 */
export function canAddUser(
  activeMembers: number,
  pendingInvites: number,
  maxUsers: number | null,
): boolean {
  if (maxUsers === null) return true;
  return activeMembers + pendingInvites < maxUsers;
}

/** Whether one more connected channel fits under `max_channels`. */
export function canAddChannel(
  channels: number,
  maxChannels: number | null,
): boolean {
  if (maxChannels === null) return true;
  return channels < maxChannels;
}

/**
 * Days left on the trial (ceil), or null when there's no expiry.
 * Negative when already expired.
 */
export function daysUntil(expiresAt: string | null, now: Date = new Date()): number | null {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - now.getTime();
  return Math.ceil(ms / 86_400_000);
}
