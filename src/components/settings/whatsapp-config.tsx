'use client';

import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Eye,
  EyeOff,
  Copy,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  Zap,
  AlertTriangle,
  RotateCcw,
  QrCode,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth, useEntitlements } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SettingsPanelHead } from './settings-panel-head';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import { WhatsAppQrPanel } from './whatsapp-qr-panel';
import type { WhatsAppConfig as WhatsAppConfigType } from '@/types';

const MASKED_TOKEN = '••••••••••••••••';

type ConnectionStatus = 'connected' | 'disconnected' | 'unknown';
type ResetReason = 'token_corrupted' | 'meta_api_error' | null;

type ChannelChoice = 'official' | 'qr';

/**
 * Settings → WhatsApp.
 *
 * "Como conectar" chooser on top: one card per channel, each shown
 * only when its module is on for the account (`channel_official`,
 * `channel_qr`). Below it, the panel for the chosen channel. With no
 * channel module at all the page says so instead of rendering a form
 * the API would reject.
 */
export function WhatsAppConfig() {
  const { t } = useLanguage();
  const ent = useEntitlements();
  const officialOn = ent.modules.channel_official;
  const qrOn = ent.modules.channel_qr;

  const [choice, setChoice] = useState<ChannelChoice | null>(null);
  // Default to the first channel the plan includes; a stored pick
  // survives only while it is still allowed.
  const active: ChannelChoice | null =
    choice && ((choice === 'official' && officialOn) || (choice === 'qr' && qrOn))
      ? choice
      : officialOn
        ? 'official'
        : qrOn
          ? 'qr'
          : null;

  const head = (
    <SettingsPanelHead
      title={t('WhatsApp connection')}
      description={t(
        'Choose how this account talks to WhatsApp: the official Meta Business API or a number linked by QR code.',
      )}
    />
  );

  if (!ent.ready) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        {head}
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      </section>
    );
  }

  if (!officialOn && !qrOn) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        {head}
        <Alert className="border-border bg-card">
          <AlertTitle className="mb-1 text-foreground">{t('No channel included in your plan')}</AlertTitle>
          <AlertDescription className="text-sm text-muted-foreground">
            {t('Your current plan does not include a WhatsApp channel. Get in touch with the SempreCRM team to add one.')}
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  return (
    <section className="animate-in fade-in-50 duration-200">
      {head}
      <div className="mb-6">
        <p className="mb-2 text-sm font-medium text-foreground">{t('How to connect')}</p>
        <div role="radiogroup" aria-label={t('How to connect')} className="grid gap-3 sm:grid-cols-2">
          {officialOn && (
            <ChannelCard
              selected={active === 'official'}
              onSelect={() => setChoice('official')}
              icon={<Zap className="size-4" />}
              title={t('Official WhatsApp API')}
              description={t('Meta Cloud API with templates, broadcasts and the 24-hour window. Recommended for scale.')}
              badge={t('Recommended')}
            />
          )}
          {qrOn && (
            <ChannelCard
              selected={active === 'qr'}
              onSelect={() => setChoice('qr')}
              icon={<QrCode className="size-4" />}
              title={t('WhatsApp via QR code')}
              description={t('Link an existing number by scanning a QR code, like WhatsApp Web. For 1:1 support only.')}
              badge={t('Unofficial')}
            />
          )}
        </div>
      </div>

      {active === 'qr' ? <WhatsAppQrPanel /> : <WhatsAppOfficialConfig />}
    </section>
  );
}

function ChannelCard({
  selected,
  onSelect,
  icon,
  title,
  description,
  badge,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  description: string;
  badge?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-colors',
        selected
          ? 'border-primary bg-primary-soft shadow-[inset_0_0_0_1px_var(--color-primary)]'
          : 'border-border bg-card hover:bg-muted/50',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md',
          selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{title}</span>
          {badge && (
            <span className="rounded-full border border-border bg-muted px-2 py-px text-[10px] font-medium text-muted-foreground">
              {badge}
            </span>
          )}
        </span>
        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

/** The Meta Cloud API form — unchanged behaviour, now one of two panels. */
function WhatsAppOfficialConfig() {
  const supabase = createClient();
  const { t, language } = useLanguage();
  // After multi-user, whatsapp_config is one-row-per-account, not
  // one-row-per-user. We pull `accountId` straight off the auth
  // context and key every read off it — so a teammate who just
  // joined an account sees the inviter's saved config without
  // having to re-enter anything.
  const { user, accountId, loading: authLoading, profileLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [config, setConfig] = useState<WhatsAppConfigType | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('unknown');
  const [resetReason, setResetReason] = useState<ResetReason>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');

  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [pin, setPin] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);

  // True once /register has succeeded on Meta's side (timestamp set
  // in the row). When false, the saved config is metadata-only and
  // Meta will silently drop every inbound event — that's the
  // multi-number bug that prompted this work.
  const isRegistered = Boolean(config?.registered_at);
  const lastRegistrationError = config?.last_registration_error ?? null;

  const [verifyingRegistration, setVerifyingRegistration] = useState(false);
  type RegistrationProbe = {
    live: boolean;
    checks: Record<string, boolean | null>;
    errors?: string[];
    last_registration_error?: string | null;
    registered_at?: string | null;
    subscribed_apps_at?: string | null;
  };
  const [registrationProbe, setRegistrationProbe] =
    useState<RegistrationProbe | null>(null);

  const webhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/whatsapp/webhook`
      : '';

  const fetchConfig = useCallback(async (acctId: string) => {
    setLoading(true);
    try {
      // Load form values from Supabase (shows what's in DB).
      // Switched from `user_id` (which would only match the row's
      // original author) to `account_id` so every member of the
      // account sees the same saved configuration. UNIQUE(account_id)
      // on the table guarantees the .maybeSingle() return type
      // remains accurate.
      const { data, error } = await supabase
        .from('whatsapp_config')
        .select('*')
        .eq('account_id', acctId)
        .maybeSingle();

      if (error) {
        console.error('Failed to load config row:', error);
      }

      if (data) {
        setConfig(data);
        setPhoneNumberId(data.phone_number_id || '');
        setWabaId(data.waba_id || '');
        setAccessToken(MASKED_TOKEN);
        setVerifyToken('');
        setPin('');
        setTokenEdited(false);
      } else {
        setConfig(null);
        setPhoneNumberId('');
        setWabaId('');
        setAccessToken('');
        setVerifyToken('');
        setPin('');
        setTokenEdited(false);
      }
      // Clear any stale probe result when reloading the row.
      setRegistrationProbe(null);

      // Then verify health via the API (decrypts token + pings Meta)
      if (data) {
        try {
          const res = await fetch('/api/whatsapp/config', { method: 'GET' });
          const payload = await res.json();

          if (payload.connected) {
            setConnectionStatus('connected');
            setResetReason(null);
            setStatusMessage('');
          } else {
            setConnectionStatus('disconnected');
            setResetReason(payload.needs_reset ? 'token_corrupted' : payload.reason === 'meta_api_error' ? 'meta_api_error' : null);
            setStatusMessage(payload.message || '');
          }
        } catch (err) {
          console.error('Health check failed:', err);
          setConnectionStatus('disconnected');
        }
      } else {
        setConnectionStatus('disconnected');
        setResetReason(null);
        setStatusMessage('');
      }
    } catch (err) {
      console.error('fetchConfig error:', err);
      toast.error(t('Failed to load WhatsApp configuration'));
    } finally {
      setLoading(false);
    }
  }, [supabase, t]);

  useEffect(() => {
    // Need both the auth session (`!authLoading`) AND the profile
    // (`!profileLoading`, which carries `accountId`). Without the
    // second guard, the effect would fire with `accountId === null`
    // for the first render window and bail without ever retrying
    // once the profile arrives.
    if (authLoading || profileLoading) return;
    if (!user || !accountId) {
      setLoading(false);
      return;
    }
    fetchConfig(accountId);
  }, [authLoading, profileLoading, user, accountId, fetchConfig]);

  async function handleSave() {
    if (!phoneNumberId.trim()) {
      toast.error(t('Phone Number ID is required'));
      return;
    }
    if (!config && (!accessToken.trim() || !tokenEdited)) {
      toast.error(t('Access Token is required for initial setup'));
      return;
    }

    try {
      setSaving(true);

      // Always POST through the API — it verifies with Meta and encrypts
      // the access_token server-side with ENCRYPTION_KEY. Skipping this
      // and writing direct to Supabase stores the token in plaintext,
      // which then fails decryption on every subsequent health check.
      const payload: Record<string, unknown> = {
        phone_number_id: phoneNumberId.trim(),
        waba_id: wabaId.trim() || null,
        verify_token: verifyToken.trim() || null,
        // Optional — only sent when the user filled it in. The server
        // requires it on first save or when changing numbers; for a
        // simple token rotation, leaving it blank skips re-register.
        pin: pin.trim() || null,
      };

      if (tokenEdited && accessToken !== MASKED_TOKEN && accessToken.trim()) {
        payload.access_token = accessToken.trim();
      } else if (config) {
        // Existing config — reuse stored encrypted token by decrypting on the
        // server. But our POST handler requires an access_token to verify
        // with Meta. If the user didn't change the token, we need to signal
        // that. Simplest: require token re-entry if they're updating.
        toast.error(t('Please re-enter the Access Token to save changes'));
        setSaving(false);
        return;
      }

      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || t('Failed to save configuration'));
        setSaving(false);
        return;
      }

      // The route now returns a structured outcome:
      //   * registered=true   → number is live, events will flow
      //   * registered=false  → credentials saved but /register
      //                         failed; UI shows the specific error
      //                         and a retry path. registration_error
      //                         is human-readable from Meta.
      if (data.registered === false && data.registration_error) {
        toast.error(
          `${t("Saved, but Meta couldn't register the number")}: ${data.registration_error}`,
          { duration: 12000 },
        );
      } else if (data.registration_skipped) {
        // Credentials saved + verified, but /register was skipped
        // because no PIN was supplied (e.g. a Meta test number).
        // Don't claim the number is "Live" — point at the
        // Registration status banner instead.
        toast.success(
          t('Credentials saved and verified. Inbound registration was skipped (no PIN) — see Registration status below.'),
          { duration: 10000 },
        );
        setPin('');
      } else {
        toast.success(
          data.phone_info?.verified_name
            ? `${t('Live')} — ${data.phone_info.verified_name} ${t('can now receive events.')}`
            : t('WhatsApp connected. Events will start flowing within a minute.'),
        );
        // Clear the PIN so subsequent saves don't accidentally
        // re-register (which would void the active subscription if
        // the PIN became stale).
        setPin('');
      }

      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('Save error:', err);
      toast.error(t('Failed to save configuration'));
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    try {
      setTesting(true);
      const res = await fetch('/api/whatsapp/config', { method: 'GET' });
      const payload = await res.json();

      if (payload.connected) {
        setConnectionStatus('connected');
        setResetReason(null);
        setStatusMessage('');
        toast.success(
          payload.phone_info?.verified_name
            ? `${t('Connected to')} ${payload.phone_info.verified_name}`
            : t('API connection successful')
        );
      } else {
        setConnectionStatus('disconnected');
        setResetReason(payload.needs_reset ? 'token_corrupted' : payload.reason === 'meta_api_error' ? 'meta_api_error' : null);
        setStatusMessage(payload.message || '');
        toast.error(payload.message || t('API connection failed'));
      }
    } catch (err) {
      console.error('Test connection error:', err);
      setConnectionStatus('disconnected');
      toast.error(t('Connection test failed. Check network and try again.'));
    } finally {
      setTesting(false);
    }
  }

  async function handleVerifyRegistration() {
    setVerifyingRegistration(true);
    setRegistrationProbe(null);
    try {
      const res = await fetch('/api/whatsapp/config/verify-registration', {
        method: 'GET',
      });
      const data = (await res.json()) as RegistrationProbe;
      setRegistrationProbe(data);
      if (data.live) {
        toast.success(t('Number is fully wired — Meta is delivering events.'));
      } else {
        toast.error(
          t('Number is not fully registered. See the checks below for which step failed.'),
          { duration: 8000 },
        );
      }
      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('verify-registration failed:', err);
      toast.error(t('Could not reach the verification endpoint.'));
    } finally {
      setVerifyingRegistration(false);
    }
  }

  async function handleReset() {
    if (!confirm(t('This will delete the current WhatsApp config so you can re-enter it. Continue?'))) {
      return;
    }

    try {
      setResetting(true);
      const res = await fetch('/api/whatsapp/config', { method: 'DELETE' });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || t('Failed to reset configuration'));
        return;
      }

      toast.success(t('Configuration cleared. You can now re-enter your credentials.'));
      setConfig(null);
      setPhoneNumberId('');
      setWabaId('');
      setAccessToken('');
      setVerifyToken('');
      setTokenEdited(false);
      setConnectionStatus('disconnected');
      setResetReason(null);
      setStatusMessage('');
    } catch (err) {
      console.error('Reset error:', err);
      toast.error(t('Failed to reset configuration'));
    } finally {
      setResetting(false);
    }
  }

  function handleCopyWebhookUrl() {
    navigator.clipboard.writeText(webhookUrl);
    toast.success(t('Webhook URL copied to clipboard'));
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  const showResetBanner = resetReason === 'token_corrupted';

  return (
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      {/* Main config form */}
      <div className="space-y-6">
        {/* Corrupted-token reset banner */}
        {showResetBanner && (
          <Alert className="bg-amber-950/40 border-amber-600/40">
            <div className="flex items-start gap-3">
              <AlertTriangle className="size-5 text-amber-400 mt-0.5 shrink-0" />
              <div className="flex-1">
                <AlertTitle className="text-amber-200 mb-1">
                  {t("Stored token can't be decrypted")}
                </AlertTitle>
                <AlertDescription className="text-amber-100/80 text-sm">
                  {statusMessage}
                </AlertDescription>
                <Button
                  onClick={handleReset}
                  disabled={resetting}
                  size="sm"
                  className="mt-3 bg-amber-600 hover:bg-amber-700 text-white"
                >
                  {resetting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      {t('Resetting...')}
                    </>
                  ) : (
                    <>
                      <RotateCcw className="size-4" />
                      {t('Reset Configuration')}
                    </>
                  )}
                </Button>
              </div>
            </div>
          </Alert>
        )}

        {/* Connection Status */}
        <Alert className="bg-card border-border">
          <div className="flex items-center gap-2">
            {connectionStatus === 'connected' ? (
              <CheckCircle2 className="size-4 text-primary" />
            ) : (
              <XCircle className="size-4 text-red-500" />
            )}
            <AlertTitle className="text-foreground mb-0">
              {connectionStatus === 'connected' ? t('Credentials valid') : t('Not Connected')}
            </AlertTitle>
          </div>
          <AlertDescription className="text-muted-foreground">
            {connectionStatus === 'connected'
              ? t('Your access token authenticates with Meta. See Registration status below for whether webhooks are actually wired.')
              : statusMessage ||
                t('Configure your Meta API credentials below to connect your WhatsApp Business account.')}
          </AlertDescription>
        </Alert>

        {/* Registration Status — the "is it actually live?" check.
            Credentials being valid is necessary but not sufficient;
            without a successful /register call the number won't
            receive inbound events. Surface this dimension separately
            so users don't trust a misleading green banner. */}
        {config && (
          <Alert
            className={
              isRegistered
                ? 'bg-emerald-950/30 border-emerald-700/50'
                : 'bg-amber-950/30 border-amber-700/50'
            }
          >
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                {isRegistered ? (
                  <CheckCircle2 className="size-4 text-emerald-400" />
                ) : (
                  <AlertTriangle className="size-4 text-amber-400" />
                )}
                <AlertTitle
                  className={
                    'mb-0 ' + (isRegistered ? 'text-emerald-200' : 'text-amber-200')
                  }
                >
                  {isRegistered
                    ? t('Registered — Meta will deliver events to SempreCRM')
                    : t('Not registered — Meta will not deliver events')}
                </AlertTitle>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleVerifyRegistration}
                disabled={verifyingRegistration}
                className="border-border bg-transparent text-foreground hover:bg-muted h-7"
              >
                {verifyingRegistration ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Zap className="size-3.5" />
                )}
                {t('Verify with Meta')}
              </Button>
            </div>
            <AlertDescription className="text-muted-foreground mt-2 text-xs leading-relaxed">
              {isRegistered ? (
                <>
                  {t('Subscribed since')}{' '}
                  {config.registered_at
                    ? new Date(config.registered_at).toLocaleString(language)
                    : t('unknown')}
                  . {t('Click "Verify with Meta" if events stop arriving.')}
                </>
              ) : lastRegistrationError ? (
                <>
                  {t('Last attempt failed with:')}{' '}
                  <span className="text-red-300">
                    &quot;{lastRegistrationError}&quot;
                  </span>
                  . {t('Enter (or correct) the 2-step PIN below and click Save Configuration to retry.')}
                </>
              ) : (
                <>
                  {t(
                    'This number was saved before registration tracking existed, or registration was skipped. Enter the 2-step PIN below and click Save Configuration to subscribe it.',
                  )}
                </>
              )}
            </AlertDescription>

            {registrationProbe && (
              <div className="mt-3 rounded border border-border bg-card/60 px-3 py-2 space-y-1.5 text-[11px]">
                <p className="font-medium text-foreground">
                  {t('Diagnostic — last run:')}{' '}
                  <span className={registrationProbe.live ? 'text-emerald-400' : 'text-amber-400'}>
                    {registrationProbe.live ? t('live') : t('not live')}
                  </span>
                </p>
                <ul className="space-y-0.5 text-muted-foreground">
                  {Object.entries(registrationProbe.checks).map(([k, v]) => (
                    <li key={k} className="flex items-center gap-1.5">
                      {v === true ? (
                        <CheckCircle2 className="size-3 text-emerald-400 shrink-0" />
                      ) : v === false ? (
                        <XCircle className="size-3 text-red-400 shrink-0" />
                      ) : (
                        <span className="size-3 rounded-full border border-border shrink-0" />
                      )}
                      <code className="text-muted-foreground">{k}</code>
                    </li>
                  ))}
                </ul>
                {(registrationProbe.errors ?? []).length > 0 && (
                  <ul className="pt-1 space-y-0.5 text-red-300">
                    {registrationProbe.errors?.map((e, i) => (
                      <li key={i}>• {e}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Alert>
        )}

        {/* API Credentials */}
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t('API Credentials')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('Enter your Meta WhatsApp Business API credentials.')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('Phone Number ID')}</Label>
              <Input
                placeholder={t('e.g. 100234567890123')}
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('WhatsApp Business Account ID')}</Label>
              <Input
                placeholder={t('e.g. 100234567890456')}
                value={wabaId}
                onChange={(e) => setWabaId(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('Permanent Access Token')}</Label>
              <div className="relative">
                <Input
                  type={showToken ? 'text' : 'password'}
                  placeholder={t('Enter your access token')}
                  value={accessToken}
                  onChange={(e) => {
                    setAccessToken(e.target.value);
                    setTokenEdited(true);
                  }}
                  onFocus={() => {
                    if (accessToken === MASKED_TOKEN) {
                      setAccessToken('');
                      setTokenEdited(true);
                    }
                  }}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  aria-label={showToken ? t('Hide token') : t('Show token')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              {config && !tokenEdited && (
                <p className="text-xs text-muted-foreground">
                  {t('Token is hidden for security. Re-enter it to update configuration.')}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('Webhook Verify Token')}</Label>
              <Input
                placeholder={t('Create a custom verify token')}
                value={verifyToken}
                onChange={(e) => setVerifyToken(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
              <p className="text-xs text-muted-foreground">
                {t('A custom string you create. Must match the token you set in Meta webhook settings.')}
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">
                {t('Two-step verification PIN')}
                <span className="ml-1 text-muted-foreground">{t('(optional)')}</span>
              </Label>
              <Input
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder={t('6-digit PIN from Meta WhatsApp Manager')}
                value={pin}
                onChange={(e) =>
                  setPin(e.target.value.replace(/\D/g, '').slice(0, 6))
                }
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground tracking-widest"
              />
              <p className="text-xs text-muted-foreground leading-relaxed">
                {t('Needed only to wire inbound messages for a production number. Set it in')}{' '}
                <strong className="text-muted-foreground">
                  {t('Meta Business Manager → WhatsApp Accounts → Phone Numbers → Two-step verification')}
                </strong>
                , {t('then paste it here so SempreCRM can subscribe the number — otherwise Meta routes inbound events to whichever app last claimed it (the symptom that hits second numbers under a shared WABA).')}{' '}
                {t('Meta test numbers have no PIN and are pre-registered — leave this blank for them. Leaving it blank also keeps an existing registration untouched.')}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Webhook URL */}
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t('Webhook Configuration')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('Use this URL as your webhook callback in the Meta App Dashboard.')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('Webhook Callback URL')}</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={webhookUrl}
                  className="bg-muted border-border text-muted-foreground font-mono text-sm"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleCopyWebhookUrl}
                  aria-label={t('Copy webhook URL')}
                  className="shrink-0 border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                >
                  <Copy className="size-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Action Buttons */}
        <div className="flex flex-wrap gap-3">
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('Saving...')}
              </>
            ) : (
              t('Save Configuration')
            )}
          </Button>
          <Button
            variant="outline"
            onClick={handleTestConnection}
            disabled={testing || !config}
            className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
          >
            {testing ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('Testing...')}
              </>
            ) : (
              <>
                <Zap className="size-4" />
                {t('Test API Connection')}
              </>
            )}
          </Button>
          {config && (
            <Button
              variant="outline"
              onClick={handleReset}
              disabled={resetting}
              className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
            >
              {resetting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('Resetting...')}
                </>
              ) : (
                <>
                  <RotateCcw className="size-4" />
                  {t('Reset Configuration')}
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Setup Instructions Sidebar */}
      <div>
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground text-base">{t('Setup Instructions')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('Follow these steps to connect your WhatsApp Business API.')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Accordion>
              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">1</span>
                    {t('Create a Meta App')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>{t('Go to')} <span className="text-primary">developers.facebook.com</span></li>
                    <li>{t('Click "My Apps" and then "Create App"')}</li>
                    <li>{t('Select "Business" as the app type')}</li>
                    <li>{t('Fill in app details and create')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">2</span>
                    {t('Add WhatsApp Product')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>{t('In your app dashboard, click "Add Product"')}</li>
                    <li>{t('Find "WhatsApp" and click "Set Up"')}</li>
                    <li>{t('Follow the setup wizard to link your business')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">3</span>
                    {t('Get API Credentials')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>{t('Go to WhatsApp > API Setup')}</li>
                    <li>{t('Copy your')} <strong className="text-foreground">{t('Phone Number ID')}</strong></li>
                    <li>{t('Copy your')} <strong className="text-foreground">{t('WhatsApp Business Account ID')}</strong></li>
                    <li>{t('Generate a')} <strong className="text-foreground">{t('Permanent Access Token')}</strong> {t('from Business Settings > System Users')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">4</span>
                    {t('Configure Webhooks')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>{t('Go to WhatsApp > Configuration')}</li>
                    <li>{t('Click "Edit" on the Webhook section')}</li>
                    <li>{t('Paste the')} <strong className="text-foreground">{t('Webhook Callback URL')}</strong> {t('from above')}</li>
                    <li>{t('Enter the same')} <strong className="text-foreground">{t('Verify Token')}</strong> {t('you set here')}</li>
                    <li>{t('Subscribe to the "messages" webhook field')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>
            </Accordion>

            <div className="mt-4 pt-4 border-t border-border">
              <a
                href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors"
              >
                <ExternalLink className="size-3.5" />
                {t('Meta WhatsApp API Documentation')}
              </a>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
