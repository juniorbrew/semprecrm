'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, ShieldCheck } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useLanguage } from '@/hooks/use-language';
import {
  isValidMfaCode,
  MFA_CODE_LENGTH,
  needsMfaChallenge,
  normalizeMfaCodeInput,
  safeNextPath,
  verifiedTotpFactors,
} from '@/lib/auth/mfa';
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

/**
 * Second step of the sign-in for users with a verified TOTP factor
 * (round 2 spec, section 7). The middleware sends every `aal1`
 * session that could be `aal2` here; a fresh challenge is created on
 * mount, the six-digit code verifies it and the session is upgraded.
 *
 * Standalone page: no AuthProvider (the shell would redirect us in a
 * loop), just the browser Supabase client.
 */
export default function MfaPage() {
  return (
    <Suspense fallback={null}>
      <MfaPageInner />
    </Suspense>
  );
}

type Stage = 'checking' | 'ready' | 'verifying' | 'no-factor';

function MfaPageInner() {
  const { t } = useLanguage();
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = safeNextPath(searchParams.get('next'));
  const supabase = createClient();

  const [stage, setStage] = useState<Stage>('checking');
  const [factorId, setFactorId] = useState<string | null>(null);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const startChallenge = useCallback(
    async (id: string) => {
      const { data, error: challengeError } = await supabase.auth.mfa.challenge({ factorId: id });
      if (challengeError || !data) {
        setError(challengeError?.message ?? t('Could not start the verification'));
        return null;
      }
      setChallengeId(data.id);
      return data.id;
    },
    [supabase, t],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: aal, error: aalError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (cancelled) return;
      if (aalError || !aal?.currentLevel) {
        // No session at all → back to the password step.
        router.replace('/login');
        return;
      }
      if (!needsMfaChallenge(aal)) {
        // Already aal2 (or no factor) — nothing to ask.
        router.replace(next);
        return;
      }
      const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
      if (cancelled) return;
      const verified = verifiedTotpFactors(factors?.totp ?? []);
      if (listError || verified.length === 0) {
        setStage('no-factor');
        return;
      }
      setFactorId(verified[0].id);
      await startChallenge(verified[0].id);
      if (!cancelled) {
        setStage('ready');
        setTimeout(() => inputRef.current?.focus(), 0);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Runs once on mount; `next` is stable for the page's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!factorId || !isValidMfaCode(code)) {
      setError(t('Enter the 6-digit code from your authenticator app'));
      return;
    }
    setStage('verifying');
    setError(null);
    // A challenge expires after a few minutes — recreate one when the
    // first attempt was slow or the previous one was consumed.
    const id = challengeId ?? (await startChallenge(factorId));
    if (!id) {
      setStage('ready');
      return;
    }
    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: id,
      code,
    });
    if (verifyError) {
      setError(t('Invalid code. Check the time on your phone and try again.'));
      setCode('');
      setChallengeId(null);
      await startChallenge(factorId);
      setStage('ready');
      setTimeout(() => inputRef.current?.focus(), 0);
      return;
    }
    // Full navigation so the middleware re-reads the upgraded cookie.
    window.location.assign(next);
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    window.location.href = '/login';
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <ShieldCheck className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl text-foreground">{t('Two-step verification')}</CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('Enter the 6-digit code from your authenticator app')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {stage === 'checking' && (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="size-6 animate-spin text-primary" />
            </div>
          )}

          {stage === 'no-factor' && (
            <div className="flex flex-col gap-4">
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {t('No authenticator is linked to this account. Sign out and sign in again.')}
              </div>
              <Button variant="outline" onClick={signOut} className="w-full">
                {t('Sign out')}
              </Button>
            </div>
          )}

          {(stage === 'ready' || stage === 'verifying') && (
            <form onSubmit={submit} className="flex flex-col gap-4" data-testid="mfa-form">
              {error && (
                <div
                  role="alert"
                  className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400"
                >
                  {error}
                </div>
              )}
              <div className="flex flex-col gap-2">
                <Label htmlFor="mfa-code" className="text-muted-foreground">
                  {t('Verification code')}
                </Label>
                <Input
                  ref={inputRef}
                  id="mfa-code"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  maxLength={MFA_CODE_LENGTH}
                  placeholder="000000"
                  value={code}
                  onChange={(e) => setCode(normalizeMfaCodeInput(e.target.value))}
                  disabled={stage === 'verifying'}
                  required
                  className="h-12 text-center font-mono text-2xl tracking-[0.5em] border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
                />
              </div>
              <Button
                type="submit"
                disabled={stage === 'verifying' || code.length !== MFA_CODE_LENGTH}
                className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {stage === 'verifying' ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('Verifying…')}
                  </>
                ) : (
                  t('Confirm')
                )}
              </Button>
              <button
                type="button"
                onClick={signOut}
                className="text-center text-sm text-muted-foreground hover:text-foreground"
              >
                {t('Sign in with another account')}
              </button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
