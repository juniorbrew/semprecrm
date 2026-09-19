'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Check,
  Copy,
  Loader2,
  ShieldCheck,
  ShieldOff,
  Smartphone,
} from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { verifyPassword } from '@/lib/auth/reauth';
import { useLanguage } from '@/hooks/use-language';
import {
  isValidMfaCode,
  MFA_CODE_LENGTH,
  MFA_FRIENDLY_NAME,
  mustEnrollMfa,
  normalizeMfaCodeInput,
  unverifiedTotpFactors,
  verifiedTotpFactors,
} from '@/lib/auth/mfa';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

// ============================================================
// Settings → Login e segurança → "Verificação em duas etapas"
// (round 2 spec, section 7). Wraps Supabase Auth TOTP:
//
//   enroll  → QR + secret → challenge + verify(6 digits) → aal2
//   disable → re-enter password → unenroll
//
// The password check for "disable" runs on a throwaway supabase-js
// client that persists nothing: `signInWithPassword` on the shared
// browser client would replace the current `aal2` session with a
// fresh `aal1` one, and GoTrue refuses to unenroll a verified factor
// from an `aal1` session.
//
// Supabase TOTP has no recovery codes — the card says so out loud.
// ============================================================

type Stage = 'loading' | 'off' | 'enrolling' | 'on';

interface Enrollment {
  factorId: string;
  qrCode: string;
  secret: string;
  uri: string;
}

/** Best-effort audit trail; the route re-checks the factor state. */
async function recordMfaAudit(event: 'enrolled' | 'disabled') {
  try {
    await fetch('/api/auth/mfa/audit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event }),
    });
  } catch (err) {
    console.warn('[MfaCard] audit call failed:', err);
  }
}

export function MfaCard() {
  const { t, language } = useLanguage();
  const { profile, mfaFactors, mfaReady, refreshMfa } = useAuth();
  const supabase = createClient();

  const [stage, setStage] = useState<Stage>('loading');
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  const [disableOpen, setDisableOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const verifiedFactor = useMemo(() => verifiedTotpFactors(mfaFactors)[0] ?? null, [mfaFactors]);

  // Mirror the shared factor list into the card's stage, except while
  // an enrollment is in progress (the list still says "off" then).
  useEffect(() => {
    if (!mfaReady) return;
    setStage((prev) => {
      if (prev === 'enrolling') return prev;
      return verifiedFactor ? 'on' : 'off';
    });
  }, [mfaReady, verifiedFactor]);

  const startEnrollment = useCallback(async () => {
    setBusy(true);
    setCodeError(null);
    try {
      // A previous attempt that never got confirmed blocks a new
      // enrollment with the same friendly name — clear those first.
      for (const stale of unverifiedTotpFactors(mfaFactors)) {
        await supabase.auth.mfa.unenroll({ factorId: stale.id });
      }
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: MFA_FRIENDLY_NAME,
      });
      if (error || !data) {
        toast.error(error?.message ?? t('Could not start two-step verification'));
        return;
      }
      setEnrollment({
        factorId: data.id,
        qrCode: data.totp.qr_code,
        secret: data.totp.secret,
        uri: data.totp.uri,
      });
      setCode('');
      setStage('enrolling');
      setTimeout(() => codeRef.current?.focus(), 0);
    } finally {
      setBusy(false);
    }
  }, [mfaFactors, supabase, t]);

  const cancelEnrollment = useCallback(async () => {
    const factorId = enrollment?.factorId;
    setEnrollment(null);
    setCode('');
    setCodeError(null);
    setStage('off');
    if (factorId) {
      // Leave no half-enrolled factor behind.
      await supabase.auth.mfa.unenroll({ factorId }).catch(() => undefined);
      await refreshMfa();
    }
  }, [enrollment?.factorId, refreshMfa, supabase]);

  const confirmEnrollment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!enrollment) return;
    if (!isValidMfaCode(code)) {
      setCodeError(t('Enter the 6-digit code from your authenticator app'));
      return;
    }
    setBusy(true);
    setCodeError(null);
    try {
      const { error } = await supabase.auth.mfa.challengeAndVerify({
        factorId: enrollment.factorId,
        code,
      });
      if (error) {
        setCodeError(t('Invalid code. Check the time on your phone and try again.'));
        setCode('');
        setTimeout(() => codeRef.current?.focus(), 0);
        return;
      }
      setEnrollment(null);
      setStage('on');
      toast.success(t('Two-step verification enabled'));
      await refreshMfa();
      void recordMfaAudit('enrolled');
    } finally {
      setBusy(false);
    }
  };

  const disable = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!verifiedFactor) return;
    if (!profile?.email) {
      toast.error(t('Cannot verify the password without a current email'));
      return;
    }
    setBusy(true);
    setPasswordError(null);
    try {
      const ok = await verifyPassword(profile.email, password);
      if (!ok) {
        setPasswordError(t('Current password is incorrect'));
        return;
      }
      const { error } = await supabase.auth.mfa.unenroll({ factorId: verifiedFactor.id });
      if (error) {
        toast.error(error.message);
        return;
      }
      setDisableOpen(false);
      setPassword('');
      setStage('off');
      toast.success(t('Two-step verification disabled'));
      await refreshMfa();
      void recordMfaAudit('disabled');
    } finally {
      setBusy(false);
    }
  };

  const copySecret = async () => {
    if (!enrollment) return;
    try {
      await navigator.clipboard.writeText(enrollment.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t('Could not copy'));
    }
  };

  const enabledSince = verifiedFactor?.updated_at ?? verifiedFactor?.created_at ?? null;

  return (
    <Card data-testid="mfa-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <ShieldCheck className="size-4 text-primary" />
          {t('Two-step verification')}
          {stage === 'on' && (
            <Badge variant="secondary" className="ml-1">
              <Check />
              {t('Enabled')}
            </Badge>
          )}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t(
            'Besides your password, sign-in asks for a 6-digit code from an authenticator app (Google Authenticator, Authy, 1Password…).',
          )}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {stage === 'loading' && (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="size-5 animate-spin text-primary" />
          </div>
        )}

        {stage === 'off' && (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              {t('Not enabled. Anyone with your password can sign in.')}
            </p>
            <Button onClick={startEnrollment} disabled={busy} data-testid="mfa-enable">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Smartphone className="size-4" />}
              {t('Enable two-step verification')}
            </Button>
          </div>
        )}

        {stage === 'enrolling' && enrollment && (
          <form onSubmit={confirmEnrollment} className="space-y-4" data-testid="mfa-enroll-form">
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>{t('Open your authenticator app and scan the QR code (or type the key).')}</li>
              <li>{t('Enter the 6-digit code the app shows to confirm.')}</li>
            </ol>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              <div className="shrink-0 rounded-lg border border-border bg-white p-2">
                {/* Supabase returns the QR as an SVG data URL — a plain <img> is the right tool. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={enrollment.qrCode}
                  alt={t('QR code for the authenticator app')}
                  width={160}
                  height={160}
                  className="block size-40"
                />
              </div>
              <div className="min-w-0 flex-1 space-y-3">
                <div className="space-y-1">
                  <Label className="text-foreground">{t('Setup key')}</Label>
                  <div className="flex items-center gap-2">
                    <code
                      className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted px-2 py-1.5 font-mono text-xs text-foreground"
                      data-testid="mfa-secret"
                      data-no-translate
                    >
                      {enrollment.secret}
                    </code>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={copySecret}
                      aria-label={t('Copy setup key')}
                    >
                      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                    </Button>
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="mfa-enroll-code" className="text-foreground">
                    {t('Verification code')}
                  </Label>
                  <Input
                    ref={codeRef}
                    id="mfa-enroll-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]*"
                    maxLength={MFA_CODE_LENGTH}
                    placeholder="000000"
                    value={code}
                    onChange={(e) => setCode(normalizeMfaCodeInput(e.target.value))}
                    disabled={busy}
                    aria-invalid={codeError ? true : undefined}
                    className="h-10 max-w-[12rem] text-center font-mono text-lg tracking-[0.4em]"
                  />
                  {codeError && (
                    <p role="alert" className="text-xs text-destructive">
                      {codeError}
                    </p>
                  )}
                </div>
              </div>
            </div>
            <Alert>
              <AlertTriangle />
              <AlertTitle>{t('There are no recovery codes')}</AlertTitle>
              <AlertDescription>
                {t(
                  'If you lose the phone with the authenticator app you will not be able to sign in. Keep the app backed up (or save the setup key somewhere safe) before continuing.',
                )}
              </AlertDescription>
            </Alert>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" onClick={cancelEnrollment} disabled={busy}>
                {t('Cancel')}
              </Button>
              <Button
                type="submit"
                disabled={busy || code.length !== MFA_CODE_LENGTH}
                data-testid="mfa-confirm"
              >
                {busy && <Loader2 className="size-4 animate-spin" />}
                {t('Confirm and enable')}
              </Button>
            </div>
          </form>
        )}

        {stage === 'on' && (
          <>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm text-muted-foreground">
                <p>{t('Your account asks for a code from the authenticator app at every sign-in.')}</p>
                {enabledSince && (
                  <p className="mt-0.5 text-xs">
                    {t('Enabled on')}{' '}
                    <span data-no-translate>
                      {new Date(enabledSince).toLocaleDateString(language, {
                        day: '2-digit',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </span>
                  </p>
                )}
              </div>
              <Button
                variant="outline"
                onClick={() => {
                  setPassword('');
                  setPasswordError(null);
                  setDisableOpen(true);
                }}
                disabled={busy}
                data-testid="mfa-disable"
              >
                <ShieldOff className="size-4" />
                {t('Disable')}
              </Button>
            </div>
            <Alert>
              <AlertTriangle />
              <AlertTitle>{t('There are no recovery codes')}</AlertTitle>
              <AlertDescription>
                {t(
                  'Without the phone that has the authenticator app you cannot sign in. If you change phones, disable and enable two-step verification again first.',
                )}
              </AlertDescription>
            </Alert>
          </>
        )}
      </CardContent>

      <Dialog open={disableOpen} onOpenChange={(open) => !busy && setDisableOpen(open)}>
        <DialogContent>
          <form onSubmit={disable} className="space-y-4" data-testid="mfa-disable-form">
            <DialogHeader>
              <DialogTitle>{t('Disable two-step verification?')}</DialogTitle>
              <DialogDescription>
                {t('Confirm your password. Sign-in will only ask for the password afterwards.')}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="mfa-disable-password" className="text-foreground">
                {t('Current password')}
              </Label>
              <Input
                id="mfa-disable-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
                required
                aria-invalid={passwordError ? true : undefined}
              />
              {passwordError && (
                <p role="alert" className="text-xs text-destructive">
                  {passwordError}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDisableOpen(false)}
                disabled={busy}
              >
                {t('Cancel')}
              </Button>
              <Button type="submit" variant="destructive" disabled={busy || !password} data-testid="mfa-disable-confirm">
                {busy && <Loader2 className="size-4 animate-spin" />}
                {t('Disable')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/**
 * Banner shown when the owner turned "Exigir duas etapas para admins"
 * on and the current admin/owner has no verified factor yet. Rendered
 * at the top of the security panel (where the shell redirects them)
 * and in the dashboard shell, so it is visible from any settings tab.
 */
export function MfaRequiredNotice({ compact = false }: { compact?: boolean }) {
  const { t } = useLanguage();
  const { accountRole, preferences, mfaReady, hasVerifiedMfa, profileLoading } = useAuth();
  if (profileLoading || !mfaReady) return null;
  if (
    !mustEnrollMfa({
      role: accountRole,
      requireMfaAdmins: preferences.require_mfa_admins,
      hasVerifiedFactor: hasVerifiedMfa,
    })
  ) {
    return null;
  }
  if (compact) {
    return (
      <div
        role="status"
        data-testid="mfa-required-banner"
        className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-700 dark:text-amber-300 sm:px-6"
      >
        <AlertTriangle className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          {t('This account requires two-step verification for administrators. Enable it to continue using the app.')}
        </span>
      </div>
    );
  }
  return (
    <Alert data-testid="mfa-required-alert" className="mb-4 border-amber-500/40">
      <AlertTriangle className="text-amber-500" />
      <AlertTitle>{t('Two-step verification required')}</AlertTitle>
      <AlertDescription>
        {t('This account requires two-step verification for administrators. Enable it below to continue using the app.')}
      </AlertDescription>
    </Alert>
  );
}
