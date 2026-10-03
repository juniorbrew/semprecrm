'use client';

// ============================================================
// MembersTab — Settings → Members
//
// Two stacked sections:
//   1. Roster   — every member of the account. Admin+ can change a
//                 teammate's role inline and remove them. Owner row
//                 is non-editable everywhere (transfer is its own
//                 separate flow, deferred to a later PR).
//   2. Pending  — outstanding invite links. Admin+ can revoke. The
//                 plaintext URL is gone after the create dialog
//                 closes, so we surface a "revoke + new link" hint
//                 rather than pretending we can resurface it.
//
// Role-gating
//   The tab itself is reachable by any member, but mutation buttons
//   are wrapped in `<RequireRole min="admin">` / `useCan` so an
//   agent or viewer sees the roster read-only. The server-side
//   RPCs (set_member_role, remove_account_member) double-check
//   the role anyway.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Loader2,
  Mail,
  MailX,
  Plus,
  Trash2,
} from 'lucide-react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RequireRole } from '@/components/auth/require-role';
import { AvailabilityDot } from '@/components/layout/availability-toggle';
import { useAuth } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import type { AccountRole } from '@/lib/auth/roles';
import { InviteMemberDialog } from './invite-member-dialog';
import { MfaRequirementToggle } from './mfa-requirement-toggle';
import { SettingsChip } from './settings-chip';
import { SettingsGroup } from './settings-group';
import { SettingsPanelHead } from './settings-panel-head';
import { ROLE_META } from './role-meta';

interface Member {
  user_id: string;
  full_name: string;
  email: string | null;
  avatar_url: string | null;
  role: AccountRole;
  joined_at: string;
  availability?: 'available' | 'away';
}

interface Invitation {
  id: string;
  role: 'admin' | 'agent' | 'viewer';
  label: string | null;
  created_at: string;
  expires_at: string;
}

// Editable roles in the inline dropdown. Owner is never an option —
// promotions go through the (deferred) Transfer Ownership flow.
// Labels are English keys rendered through t().
const EDITABLE_ROLES: { value: AccountRole; label: string; hint: string }[] = [
  { value: 'admin', label: 'Admin', hint: 'Manage members + everything' },
  { value: 'agent', label: 'Agent', hint: 'Use features; no settings' },
  { value: 'viewer', label: 'Viewer', hint: 'Read-only across the app' },
];

const ROLE_LABELS: Record<AccountRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  agent: 'Agent',
  viewer: 'Viewer',
};

// Per-role chip metadata (icon / label / colour) lives in the shared
// ROLE_META module so this roster and the Overview identity chip can't
// drift. The colour scale runs amber (owner — scarce, immutable) →
// primary (admin) → muted (agent / viewer).

function fmtDate(iso: string, locale: string): string {
  // Match the rest of the dashboard's locale-light formatting.
  const d = new Date(iso);
  return d.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function fmtExpiresIn(iso: string, t: (s: string) => string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return t('expired');
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${t('expires in')} ${days} ${days === 1 ? t('day') : t('days')}`;
  const hours = Math.max(1, Math.floor(ms / (60 * 60 * 1000)));
  return `${t('expires in')} ${hours} ${hours === 1 ? t('hour') : t('hours')}`;
}

export function MembersTab() {
  const { user, canManageMembers } = useAuth();
  const { t, language } = useLanguage();

  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [removingMember, setRemovingMember] = useState<Member | null>(null);
  const [pendingMemberAction, setPendingMemberAction] = useState<string | null>(
    null,
  );

  const loadEverything = useCallback(async () => {
    try {
      const [mres, ires] = await Promise.all([
        fetch('/api/account/members', { cache: 'no-store' }),
        canManageMembers
          ? fetch('/api/account/invitations', { cache: 'no-store' })
          : Promise.resolve(null),
      ]);

      if (!mres.ok) {
        const payload = await mres.json().catch(() => ({}));
        toast.error(payload.error || t('Failed to load members'));
        return;
      }
      const mdata = (await mres.json()) as { members: Member[] };
      setMembers(mdata.members);

      if (ires) {
        if (!ires.ok) {
          const payload = await ires.json().catch(() => ({}));
          toast.error(payload.error || t('Failed to load invitations'));
          return;
        }
        const idata = (await ires.json()) as { invitations: Invitation[] };
        setInvitations(idata.invitations);
      } else {
        setInvitations([]);
      }
    } catch (err) {
      console.error('[MembersTab] load error:', err);
      toast.error(t('Could not reach the server'));
    } finally {
      setLoading(false);
    }
  }, [canManageMembers, t]);

  useEffect(() => {
    void loadEverything();
  }, [loadEverything]);

  async function handleRoleChange(member: Member, nextRole: AccountRole) {
    if (member.role === nextRole) return;
    // Optimistic update — flip the dropdown immediately so the UI
    // feels snappy. If the server PATCH fails we revert below so
    // the dropdown doesn't lie about the persisted state.
    const previousRole = member.role;
    setPendingMemberAction(member.user_id);
    setMembers((prev) =>
      prev.map((m) =>
        m.user_id === member.user_id ? { ...m, role: nextRole } : m,
      ),
    );
    try {
      const res = await fetch(`/api/account/members/${member.user_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: nextRole }),
      });
      if (!res.ok) {
        // Revert the optimistic flip. The toast on its own wasn't
        // enough — the dropdown was left showing the new role
        // forever, so the next interaction operated on a wrong
        // baseline (re-trying the same change would no-op via the
        // `member.role === nextRole` guard at the top).
        setMembers((prev) =>
          prev.map((m) =>
            m.user_id === member.user_id ? { ...m, role: previousRole } : m,
          ),
        );
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('Failed to update role'));
        return;
      }
      toast.success(
        `${t('Role updated')}: ${member.full_name || t('member')} → ${t(ROLE_LABELS[nextRole])}`,
      );
    } catch (err) {
      // Same revert on network failure.
      setMembers((prev) =>
        prev.map((m) =>
          m.user_id === member.user_id ? { ...m, role: previousRole } : m,
        ),
      );
      console.error('[MembersTab] role change error:', err);
      toast.error(t('Could not reach the server'));
    } finally {
      setPendingMemberAction(null);
    }
  }

  async function handleRemove() {
    if (!removingMember) return;
    setPendingMemberAction(removingMember.user_id);
    try {
      const res = await fetch(
        `/api/account/members/${removingMember.user_id}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('Failed to remove member'));
        return;
      }
      toast.success(t('Member removed'));
      setMembers((prev) =>
        prev.filter((m) => m.user_id !== removingMember.user_id),
      );
      setRemovingMember(null);
    } catch (err) {
      console.error('[MembersTab] remove error:', err);
      toast.error(t('Could not reach the server'));
    } finally {
      setPendingMemberAction(null);
    }
  }

  async function handleRevoke(invite: Invitation) {
    try {
      const res = await fetch(`/api/account/invitations/${invite.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('Failed to revoke invitation'));
        return;
      }
      toast.success(t('Invitation revoked'));
      setInvitations((prev) => prev.filter((i) => i.id !== invite.id));
    } catch (err) {
      console.error('[MembersTab] revoke error:', err);
      toast.error(t('Could not reach the server'));
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <section className="max-w-2xl">
      <SettingsPanelHead
        title={t('Team members')}
        description={t('People with access to this account. Roles control what each teammate can do.')}
        action={
          <RequireRole min="admin">
            <Button onClick={() => setInviteOpen(true)}>
              <Plus className="size-4" />
              {t('Invite member')}
            </Button>
          </RequireRole>
        }
      />

      <div className="space-y-8">
      {/* Roster */}
      <div>
          <ul className="divide-y divide-border">
            {members.map((member) => {
              const roleMeta = ROLE_META[member.role];
              const RoleIcon = roleMeta.icon;
              const isSelf = member.user_id === user?.id;
              const isOwnerRow = member.role === 'owner';
              const isBusy = pendingMemberAction === member.user_id;

              return (
                <li
                  key={member.user_id}
                  // Mobile: stack identity (avatar+name+email) above the
                  // role/remove actions so the role dropdown's fixed
                  // 128px width doesn't force the name into a 50-pixel
                  // truncation. Desktop (sm+): everything inline as
                  // before.
                  className="flex flex-col gap-3 py-2.5 sm:flex-row sm:items-center sm:gap-4"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span
                      className="relative shrink-0"
                      title={member.availability === 'away' ? t('Away') : t('Available')}
                    >
                      <Avatar className="size-9">
                        {member.avatar_url ? (
                          <AvatarImage
                            src={member.avatar_url}
                            alt={member.full_name || t('Member')}
                          />
                        ) : null}
                        <AvatarFallback className="bg-primary/10 text-sm font-medium text-primary">
                          {(member.full_name || member.email || 'U')
                            .charAt(0)
                            .toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <AvailabilityDot
                        availability={member.availability}
                        className="absolute -bottom-0.5 -right-0.5"
                      />
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {member.full_name || t('Unnamed')}
                        </span>
                        {isSelf && (
                          <SettingsChip variant="muted">{t('You')}</SettingsChip>
                        )}
                        {member.availability === 'away' && (
                          <SettingsChip variant="muted">{t('Away')}</SettingsChip>
                        )}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {member.email}
                        {member.email ? ' · ' : ''}
                        {/* Joined date stays desktop-only. The mobile row's
                            vertical density makes the joined date noise. */}
                        <span className="hidden tabular-nums sm:inline">
                          {t('Joined')} {fmtDate(member.joined_at, language)}
                        </span>
                      </p>
                    </div>
                  </div>

                  {/* Actions cluster. On mobile this is its own row
                      below the identity block; on desktop it sits
                      inline. Items align to the start on mobile so the
                      role dropdown lines up under the avatar. */}
                  <div className="flex items-center gap-2 sm:gap-3">
                    {/* Role display / editor. Inline Select is admin+
                        only AND not allowed on the owner row (owner
                        changes go through transfer, which lands later). */}
                    {canManageMembers && !isOwnerRow && !isSelf ? (
                      <Select
                        value={member.role}
                        onValueChange={(v) =>
                          // Base UI Select can emit null on clear. We
                          // don't expose a clear affordance, so the
                          // guard is defensive — but the typed
                          // signature requires it.
                          v && handleRoleChange(member, v as AccountRole)
                        }
                      >
                        <SelectTrigger
                          size="sm"
                          className="w-32"
                          disabled={isBusy}
                        >
                          {/* Base UI renders the raw value ("agent") unless
                              told how to label it — always go through the
                              role label map. */}
                          <SelectValue>
                            {(v: AccountRole | null) =>
                              v ? t(ROLE_LABELS[v]) : null
                            }
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {EDITABLE_ROLES.map((r) => (
                            <SelectItem key={r.value} value={r.value}>
                              {t(r.label)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <SettingsChip variant={roleMeta.variant}>
                        <RoleIcon />
                        {t(ROLE_LABELS[member.role])}
                      </SettingsChip>
                    )}

                    {/* Remove. Admin+ only; never on the owner row;
                        never on yourself. Pre-polish styling was
                        neutral-default + red-on-hover — the
                        destructive intent was invisible until the
                        user moused over. Now red is the default
                        state with a darker shade on hover so the
                        affordance reads at-a-glance. */}
                    {canManageMembers && !isOwnerRow && !isSelf && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setRemovingMember(member)}
                        disabled={isBusy}
                        aria-label={t('Remove member')}
                        title={t('Remove member')}
                        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
      </div>

      {/* Pending invitations — admin+ only */}
      <RequireRole min="admin">
        <SettingsGroup
          title={
            <>
              {t('Pending invitations')}
              <SettingsChip variant="muted" className="tabular-nums tracking-normal normal-case">
                {invitations.length}
              </SettingsChip>
            </>
          }
        >
          {/* P10 — make the no-resend design explicit. Admins were
              confused why the pending list shows roles + expiry but
              no "copy link again" button. Stating the constraint up
              front (rather than letting the user discover it by
              looking for a button) keeps it from feeling like a bug. */}
          {invitations.length > 0 ? (
            <p className="-mt-2 text-xs text-muted-foreground">
              {t(
                'The plaintext invite URL is only shown once at creation for security — to re-share, revoke the invite below and create a new one.',
              )}
            </p>
          ) : null}

          {invitations.length === 0 ? (
            <div className="flex items-start gap-3 py-2">
              <Mail className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">
                  {t('No pending invitations.')}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t('Click "Invite member" above to generate a shareable link.')}
                </p>
              </div>
            </div>
          ) : (
                <ul className="divide-y divide-border">
                  {invitations.map((inv) => {
                    const inviteRoleMeta = ROLE_META[inv.role];
                    const InviteRoleIcon = inviteRoleMeta.icon;
                    return (
                    <li
                      key={inv.id}
                      className="flex items-center gap-4 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground">
                            {inv.label || t('Untitled invite')}
                          </span>
                          <SettingsChip variant={inviteRoleMeta.variant}>
                            <InviteRoleIcon />
                            {t(ROLE_LABELS[inv.role])}
                          </SettingsChip>
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                          {t('Created')} {fmtDate(inv.created_at, language)} · {fmtExpiresIn(inv.expires_at, t)}
                        </p>
                      </div>

                      {/* Revoke: red default state, mirrors the
                          members-tab Remove button. Pre-polish version
                          read as a neutral secondary button until
                          hover. */}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRevoke(inv)}
                        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      >
                        <MailX className="size-4" />
                        {t('Revoke')}
                      </Button>
                    </li>
                    );
                  })}
                </ul>
          )}
        </SettingsGroup>
      </RequireRole>

      {/* Owner-only security policy for the team (round 2 spec, section 7). */}
      <RequireRole min="owner">
        <SettingsGroup title={t('Security policy')}>
          <MfaRequirementToggle />
        </SettingsGroup>
      </RequireRole>
      </div>

      <InviteMemberDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onCreated={loadEverything}
      />

      <Dialog
        open={removingMember !== null}
        onOpenChange={(open) => {
          if (!open) setRemovingMember(null);
        }}
      >
        <DialogContent className="bg-popover border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-popover-foreground">
              <AlertTriangle className="size-4 text-amber-400" />
              {t('Remove member')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('Remove')}{' '}
              <span className="font-medium text-muted-foreground">
                {removingMember?.full_name || t('this teammate')}
              </span>{' '}
              {t(
                'from the account? They will be signed out of this account and given a fresh personal account on their next sign-in. Their login is not deleted.',
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setRemovingMember(null)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('Cancel')}
            </Button>
            <Button
              onClick={handleRemove}
              disabled={!!pendingMemberAction}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {pendingMemberAction ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('Removing...')}
                </>
              ) : (
                t('Remove member')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
