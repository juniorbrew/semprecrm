'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, ShieldCheck } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

/**
 * Owner-only toggle "Exigir duas etapas para admins"
 * (`accounts.preferences.require_mfa_admins`, round 2 spec, section
 * 7). Saved through POST /api/account/preferences so the change is
 * audited (`preferences.updated`) and merged over the live jsonb.
 *
 * The parent (members-tab) wraps this in `<RequireRole min="owner">`.
 */
export function MfaRequirementToggle() {
  const { t } = useLanguage();
  const { preferences, refreshAccount, hasVerifiedMfa, mfaReady } = useAuth();
  const [checked, setChecked] = useState(preferences.require_mfa_admins);
  const [saving, setSaving] = useState(false);

  // Follow the account row (another tab may have saved meanwhile).
  useEffect(() => {
    setChecked(preferences.require_mfa_admins);
  }, [preferences.require_mfa_admins]);

  const onChange = async (next: boolean) => {
    const previous = checked;
    setChecked(next);
    setSaving(true);
    try {
      const res = await fetch('/api/account/preferences', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ require_mfa_admins: next }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        setChecked(previous);
        toast.error(payload.error || t('Could not save the setting'));
        return;
      }
      await refreshAccount();
      toast.success(
        next
          ? t('Two-step verification is now required for administrators')
          : t('Two-step verification is no longer required for administrators'),
      );
    } catch (err) {
      console.error('[MfaRequirementToggle] save error:', err);
      setChecked(previous);
      toast.error(t('Could not reach the server'));
    } finally {
      setSaving(false);
    }
  };

  const showSelfWarning = checked && mfaReady && !hasVerifiedMfa;

  return (
    <Card data-testid="mfa-requirement-card">
      <CardContent className="flex items-start gap-4 py-4">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <ShieldCheck className="size-4 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <Label htmlFor="require-mfa-admins" className="text-sm font-medium text-foreground">
            {t('Require two-step verification for administrators')}
          </Label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t(
              'Owners and admins without an authenticator app are sent to Login e segurança until they enable it. Agents and viewers are not affected.',
            )}
          </p>
          {showSelfWarning && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              {t('You have not enabled two-step verification yet — this applies to you too.')}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {saving && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          <Switch
            id="require-mfa-admins"
            checked={checked}
            onCheckedChange={(value) => void onChange(Boolean(value))}
            disabled={saving}
            aria-label={t('Require two-step verification for administrators')}
            data-testid="require-mfa-admins"
          />
        </div>
      </CardContent>
    </Card>
  );
}
