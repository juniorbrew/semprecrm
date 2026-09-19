'use client';

// ============================================================
// InviteMemberDialog
//
// Two-step modal:
//   1. Form  — role + expiry + optional label → POST creates the invite.
//   2. Result — the share URL, returned ONCE. Copy-to-clipboard, plus a
//              "Send via WhatsApp" deep link that pre-fills wa.me with
//              a friendly message containing the URL.
//
// The plaintext token is server-stored only as a SHA-256 hash, so once
// the result step is dismissed the link is gone forever — the dialog
// shouts this in copy.
// ============================================================

import { useState } from 'react';
import { toast } from 'sonner';
import { Copy, Loader2, MessageCircle, Sparkles } from 'lucide-react';

import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAuth } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';

type InviteRole = 'admin' | 'agent' | 'viewer';

interface InviteMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful create so the parent re-fetches the
   *  pending-invitations list. */
  onCreated: () => void;
}

const EXPIRY_OPTIONS: { value: string; label: string }[] = [
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
];

// English keys — rendered through t() so the dropdown follows the UI language.
const ROLE_LABELS: Record<InviteRole, string> = {
  admin: 'Admin',
  agent: 'Agent',
  viewer: 'Viewer',
};

const ROLE_DESCRIPTIONS: Record<InviteRole, string> = {
  admin:
    'Can invite teammates, manage settings, send messages, and edit data.',
  agent:
    'Can use the inbox, contacts, broadcasts, automations, and flows. No settings or member access.',
  viewer: 'Read-only access across every page. Cannot send or edit anything.',
};

// Server caps label at 80 chars (see src/app/api/account/invitations/route.ts).
// Mirror it on the client so we short-circuit before the round-trip
// rather than letting the user submit and bounce off a 400.
const MAX_LABEL_LEN = 80;

interface CreatedInvite {
  url: string;
  role: InviteRole;
  expiresInDays: number;
  /** Snapshotted at creation time so a later account rename can't
   *  retroactively change the wa.me message text on the result step. */
  accountName: string;
}

export function InviteMemberDialog({
  open,
  onOpenChange,
  onCreated,
}: InviteMemberDialogProps) {
  const { account } = useAuth();
  const { t } = useLanguage();
  const [role, setRole] = useState<InviteRole>('agent');
  const [expiry, setExpiry] = useState<string>('7');
  const [label, setLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CreatedInvite | null>(null);

  function reset() {
    setRole('agent');
    setExpiry('7');
    setLabel('');
    setResult(null);
    setSubmitting(false);
  }

  async function handleCreate() {
    // Mirror the server's max-length check so we don't ship an
    // obviously-too-long label across the wire just to bounce off
    // a 400. The Input also has a `maxLength={MAX_LABEL_LEN}` cap
    // but a paste can land an over-limit string into state before
    // the limit kicks in on the next keystroke — this is the safety
    // net for that path.
    const trimmedLabel = label.trim();
    if (trimmedLabel.length > MAX_LABEL_LEN) {
      toast.error(`${t('Label must be')} ${MAX_LABEL_LEN} ${t('characters or fewer')}`);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/account/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role,
          expiresInDays: Number(expiry),
          label: trimmedLabel || undefined,
        }),
      });

      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('Failed to create invitation'));
        return;
      }

      const data = (await res.json()) as {
        url: string;
        expiresInDays: number;
      };

      setResult({
        url: data.url,
        role,
        expiresInDays: data.expiresInDays,
        // Snapshot the account name into the result so the wa.me
        // share message has team context. Falls back to a generic
        // string if `account` hasn't loaded yet (shouldn't happen
        // — the dialog requires admin+ which requires a loaded
        // profile — but stay safe).
        accountName: account?.name ?? t('our SempreCRM account'),
      });
      onCreated();
    } catch (err) {
      console.error('[InviteMemberDialog] create error:', err);
      toast.error(t('Could not reach the server. Try again?'));
    } finally {
      setSubmitting(false);
    }
  }

  async function copyToClipboard() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.url);
      toast.success(t('Invite link copied'));
    } catch {
      // Most likely "not in a secure context" — happens on http://
      // local IPs. Surface the link in the toast so the admin can
      // hand-copy it.
      toast.error(t('Clipboard blocked — copy the link manually'));
    }
  }

  function whatsappShareUrl(url: string): string {
    // Include the account name so the recipient knows which team
    // they're being invited to before clicking through. This matters
    // for users in multi-team contexts where "our SempreCRM account"
    // wouldn't be enough to disambiguate.
    const accountName = result?.accountName ?? t('our SempreCRM account');
    const message = t(
      'Join {account} on SempreCRM using this link (valid for {days} days): {url}',
    )
      .replace('{account}', accountName)
      .replace('{days}', String(result?.expiresInDays ?? ''))
      .replace('{url}', url);
    return `https://wa.me/?text=${encodeURIComponent(message)}`;
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Reset state when the dialog closes — both for cancel and
        // for dismissal after a successful create. The plaintext URL
        // is intentionally NOT preserved across opens.
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="bg-popover border-border sm:max-w-md">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-popover-foreground">
                <Sparkles className="size-4 text-primary" />
                {t('Invite created')}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {t(
                  'Share this link with your new teammate. They will be able to sign up (or sign in) and join the account as',
                )}{' '}
                <span className="font-medium text-muted-foreground">
                  {t(ROLE_LABELS[result.role])}
                </span>
                . {t('The link is valid for')}{' '}
                <span className="font-medium text-muted-foreground">
                  {result.expiresInDays}{' '}
                  {result.expiresInDays === 1 ? t('day') : t('days')}
                </span>
                .
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 py-2">
              <Label className="text-muted-foreground">{t('Invite link')}</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={result.url}
                  className="bg-muted border-border text-foreground font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button
                  type="button"
                  onClick={copyToClipboard}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground shrink-0"
                >
                  <Copy className="size-4" />
                  {t('Copy')}
                </Button>
              </div>

              {/* Higher-contrast amber than the original 10% / amber-200.
                  Reviewed against slate-900 to meet WCAG AAA for body
                  text (target ratio 7:1). Border bumped to /50, bg to
                  /15, foreground promoted to amber-100 for the strong
                  intro, amber-200 for the body. */}
              <div className="rounded-md border border-amber-500/50 bg-amber-500/15 px-3 py-2 text-xs text-amber-200">
                <strong className="font-semibold text-amber-100">
                  {t('Save this link now.')}
                </strong>{' '}
                {t(
                  'We never store the plaintext — once you close this dialog the URL is gone. To re-share, revoke this invite and create a new one.',
                )}
              </div>

              {/* Anchor styled with `buttonVariants` rather than wrapping
                  in <Button asChild>. The SempreCRM Button is the Base UI
                  ButtonPrimitive — it has no Radix-style asChild slot.
                  Direct anchor preserves right-click "Open in new tab"
                  behaviour too. */}
              <a
                href={whatsappShareUrl(result.url)}
                target="_blank"
                rel="noreferrer noopener"
                className={buttonVariants({
                  variant: 'outline',
                  className:
                    'w-full border-border text-muted-foreground hover:bg-muted',
                })}
              >
                <MessageCircle className="size-4" />
                {t('Send via WhatsApp')}
              </a>
            </div>

            <DialogFooter className="bg-popover border-border">
              <Button
                onClick={() => onOpenChange(false)}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                {t('Done')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">{t('Invite a teammate')}</DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {t(
                  'Generate a one-time invite link. Share it via WhatsApp, Slack, or any channel you like — no email service required.',
                )}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label className="text-muted-foreground">{t('Role')}</Label>
                <Select
                  value={role}
                  onValueChange={(v) => v && setRole(v as InviteRole)}
                >
                  <SelectTrigger className="w-full bg-muted border-border text-foreground">
                    <SelectValue>
                      {(v: InviteRole | null) => (v ? t(ROLE_LABELS[v]) : null)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">{t(ROLE_LABELS.admin)}</SelectItem>
                    <SelectItem value="agent">{t(ROLE_LABELS.agent)}</SelectItem>
                    <SelectItem value="viewer">{t(ROLE_LABELS.viewer)}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t(ROLE_DESCRIPTIONS[role])}
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">{t('Link valid for')}</Label>
                <Select
                  value={expiry}
                  onValueChange={(v) => v && setExpiry(v)}
                >
                  <SelectTrigger className="w-full bg-muted border-border text-foreground">
                    <SelectValue>
                      {(v: string | null) => {
                        const opt = EXPIRY_OPTIONS.find((o) => o.value === v);
                        return opt ? t(opt.label) : v;
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {t(opt.label)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  {t('Label')}{' '}
                  <span className="text-xs text-muted-foreground">{t('(optional)')}</span>
                </Label>
                <Input
                  placeholder={t('e.g. Sara — support team')}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  maxLength={MAX_LABEL_LEN}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
                <p className="text-xs text-muted-foreground">
                  {t('Helps you remember who you sent the link to in the pending list below.')}
                </p>
              </div>
            </div>

            <DialogFooter className="bg-popover border-border">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                {t('Cancel')}
              </Button>
              <Button
                onClick={handleCreate}
                disabled={submitting}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('Creating...')}
                  </>
                ) : (
                  t('Generate link')
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
