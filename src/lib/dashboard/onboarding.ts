// ============================================================
// "Primeiros passos" — the setup checklist a new account sees on the
// dashboard (found in the end-to-end new-customer pass: a fresh account
// landed on an empty dashboard with no pointer to connecting WhatsApp).
//
// Every step is derived from data the account already has, so it ticks
// itself; nothing is stored. Admins only (the steps are settings).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { whatsappConnectionBanner } from '@/lib/whatsapp/connection-banner'

export type OnboardingStepId = 'whatsapp' | 'contacts' | 'team' | 'ai'

export interface OnboardingStep {
  id: OnboardingStepId
  title: string
  description: string
  href: string
  action: string
  /** Optional steps never block "done" (the card hides when the required ones are). */
  optional?: boolean
}

/** English copy (pt-BR in src/lib/i18n-dict/dashboard.ts). */
export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    id: 'whatsapp',
    title: 'Connect WhatsApp',
    description: 'Link the official Meta API or a number by QR code to receive and answer customers.',
    href: '/settings?tab=whatsapp',
    action: 'Connect',
  },
  {
    id: 'contacts',
    title: 'Add your contacts',
    description: 'Create one or import a spreadsheet — or wait for the first customer to write.',
    href: '/contacts',
    action: 'Open contacts',
  },
  {
    id: 'team',
    title: 'Invite your team',
    description: 'Send a link so your attendants answer conversations with you.',
    href: '/settings?tab=members',
    action: 'Invite',
  },
  {
    id: 'ai',
    title: 'Set up the AI assistant',
    description: 'Suggested replies from your knowledge base. Optional.',
    href: '/settings?tab=ai',
    action: 'Set up',
    optional: true,
  },
]

export type OnboardingStatus = Record<OnboardingStepId, boolean>

/** Account data → which steps are done. Pure, so it is what the tests pin. */
export function onboardingStatus(input: {
  officialStatus: string | null | undefined
  qrStatus: string | null | undefined
  contacts: number
  members: number
  pendingInvites: number
  aiEnabled: boolean
}): OnboardingStatus {
  return {
    whatsapp: whatsappConnectionBanner({ officialStatus: input.officialStatus, qrStatus: input.qrStatus }) === null,
    contacts: input.contacts > 0,
    team: input.members > 1 || input.pendingInvites > 0,
    ai: input.aiEnabled,
  }
}

/** True when every required (non-optional) step is done. */
export function onboardingComplete(status: OnboardingStatus): boolean {
  return ONBOARDING_STEPS.every((s) => s.optional || status[s.id])
}

/** Whole days left in a trial (rounded up), or null when not on a trial. */
export function trialDaysLeft(
  planStatus: string | null | undefined,
  expiresAt: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (planStatus !== 'trial' || !expiresAt) return null
  const ms = new Date(expiresAt).getTime() - now.getTime()
  if (!Number.isFinite(ms)) return null
  return Math.max(0, Math.ceil(ms / 86_400_000))
}

/** Reads the account's data with the caller's RLS client (admin+). */
export async function loadOnboardingStatus(db: SupabaseClient, accountId: string): Promise<OnboardingStatus> {
  const [official, qr, contacts, members, invites, ai] = await Promise.all([
    db.from('whatsapp_config').select('status').eq('account_id', accountId).maybeSingle(),
    db.from('wa_qr_sessions').select('status').eq('account_id', accountId).maybeSingle(),
    db.from('contacts').select('id', { count: 'exact', head: true }).eq('account_id', accountId),
    db.from('profiles').select('user_id', { count: 'exact', head: true }).eq('account_id', accountId),
    db
      .from('account_invitations')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .is('accepted_at', null)
      .gt('expires_at', new Date().toISOString()),
    db.from('ai_settings').select('enabled').eq('account_id', accountId).maybeSingle(),
  ])
  for (const r of [official, qr, contacts, members, invites, ai]) {
    if (r.error) throw new Error(`onboarding status failed: ${r.error.message}`)
  }
  return onboardingStatus({
    officialStatus: (official.data as { status?: string } | null)?.status,
    qrStatus: (qr.data as { status?: string } | null)?.status,
    contacts: contacts.count ?? 0,
    members: members.count ?? 0,
    pendingInvites: invites.count ?? 0,
    aiEnabled: (ai.data as { enabled?: boolean } | null)?.enabled === true,
  })
}
