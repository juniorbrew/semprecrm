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
import type { Language } from '@/lib/i18n';
import { SettingsChip, StatusDot } from './settings-chip';
import {
  DANGER_TEXT_BUTTON,
  SETTINGS_HEADING,
  SettingsDangerZone,
  SettingsGroup,
} from './settings-group';
import { SettingsPanelHead } from './settings-panel-head';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import { WhatsAppQrPanel } from './whatsapp-qr-panel';
import type { WhatsAppConfig as WhatsAppConfigType } from '@/types';
import { subscriptionNotice } from '@/lib/whatsapp/waba-pairing';

const MASKED_TOKEN = '••••••••••••••••';

type ConnectionStatus = 'connected' | 'disconnected' | 'unknown';
type ResetReason = 'token_corrupted' | 'meta_api_error' | null;

type ChannelChoice = 'official' | 'qr';

const COPY: Record<Language, { danger: string }> = {
  'pt-BR': { danger: 'Zona de risco' },
  'en-US': { danger: 'Danger zone' },
};

// Meta ids are decimal digit strings — mirrors the server-side check in
// POST /api/whatsapp/config so the obvious paste mistakes get a named
// field before a round-trip (wacrm #505).
const META_ID_RE = /^\d+$/;

// `meta` object the config route attaches to every failed Meta call
// (wacrm #505): what a user quotes to Meta support.
type MetaErrorMeta = {
  code: number | null;
  subcode: number | null;
  fbtrace_id: string | null;
  step: string;
  field?: string | null;
  message?: string | null;
};
type MetaFailure = { message: string; meta: MetaErrorMeta | null };
type WabaSubscription = {
  checked: boolean;
  subscribed: boolean | null;
  app_id_match: boolean | null;
  error?: string;
  error_pt?: string;
};

// Static copy — English keys translated through the i18n dictionary.
const PHONE_ID_NOT_NUMERIC =
  'Phone Number ID must contain only digits. Copy the numeric id from Meta → WhatsApp → API Setup, not the phone number itself.';
const WABA_ID_NOT_NUMERIC =
  'WhatsApp Business Account ID must contain only digits. Copy it from Meta → WhatsApp → API Setup.';
const WABA_SUBSCRIBED =
  'The WhatsApp Business Account is subscribed to this app — inbound webhooks can be delivered.';
const WABA_OTHER_APP =
  'The WhatsApp Business Account is subscribed to a different Meta app, not this one, so inbound webhooks go to that app. Save again with an access token from this app to subscribe it.';
const SAVED_WITH_WARNING = 'Saved, but with a warning';
const WABA_NOT_SUBSCRIBED =
  'The WhatsApp Business Account is not subscribed to this app, so Meta will not deliver inbound webhooks. Re-enter the access token and save again to subscribe it.';

// Connect-flow step (wire value from the route) → English label key.
const META_STEP_LABELS: Record<string, string> = {
  verify_number: 'Reading the phone number',
  waba_phone_numbers: 'Listing the WABA phone numbers',
  register: 'Registering the phone number',
  subscribe_waba: 'Subscribing the WABA to the app',
  subscribed_apps: 'Reading the WABA subscriptions',
};

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
      <section className="max-w-2xl">
        {head}
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </section>
    );
  }

  if (!officialOn && !qrOn) {
    return (
      <section className="max-w-2xl">
        {head}
        <div role="note">
          <p className="text-sm font-medium text-foreground">{t('No channel included in your plan')}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('Your current plan does not include a WhatsApp channel. Get in touch with the SempreCRM team to add one.')}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="max-w-2xl">
      {head}
      <div className="mb-8 space-y-3">
        <h3 className={SETTINGS_HEADING}>{t('How to connect')}</h3>
        <div role="radiogroup" aria-label={t('How to connect')} className="grid gap-2 sm:grid-cols-2">
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
        'flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors duration-150 motion-reduce:transition-none',
        'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
        selected
          ? 'border-transparent bg-primary/10 ring-1 ring-primary/40'
          : 'border-border hover:bg-muted/50',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex shrink-0 items-center justify-center [&_svg]:size-4',
          selected ? 'text-primary' : 'text-muted-foreground',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{title}</span>
          {badge && <SettingsChip variant="muted">{badge}</SettingsChip>}
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
  const { user, accountId, loading: authLoading, profileLoading, canEditSettings } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [config, setConfig] = useState<Omit<WhatsAppConfigType, 'access_token' | 'verify_token'> | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('unknown');
  const [resetReason, setResetReason] = useState<ResetReason>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');
  // Structured details of the last failed Meta call (health check or
  // save) — rendered as small muted text under the actionable message.
  const [statusMeta, setStatusMeta] = useState<MetaErrorMeta | null>(null);
  const [saveFailure, setSaveFailure] = useState<MetaFailure | null>(null);
  // Saved, but a non-fatal Meta step failed (WABA phone list or
  // subscribed_apps) — shown until the next save / reset.
  const [saveWarning, setSaveWarning] = useState<MetaFailure | null>(null);
  const [wabaSubscription, setWabaSubscription] = useState<WabaSubscription | null>(null);
  // The config route's Meta explanations embed ids and Meta's own text,
  // so the DOM dictionary can't translate them; it sends a pt-BR
  // rendition alongside (`*_pt`). Pick the one for the active language.
  const localized = useCallback(
    (en: string | null | undefined, pt: string | null | undefined): string =>
      (language === 'pt-BR' ? pt || en : en) || '',
    [language],
  );

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
  // Probe check keys → English label keys (rendered through t()). The
  // route reports raw flags; the UI never shows them verbatim.
  const PROBE_CHECK_LABELS: Record<string, string> = {
    config_exists: 'Configuration saved',
    token_decryptable: 'Access token readable',
    phone_metadata_ok: 'Phone number recognised by Meta',
    waba_subscribed_to_app: 'WABA subscribed to the app',
    locally_marked_registered: 'Number registered in SempreCRM',
  };
  // Probe errors are "<check>: <transport/Meta detail>". Localise the
  // prefix and the common transport failures; keep Meta's own text.
  const PROBE_ERROR_PREFIXES: [RegExp, string][] = [
    [/^Phone metadata check failed: (.+)$/, 'Phone number check failed:'],
    [/^WABA subscription check failed: (.+)$/, 'WABA subscription check failed:'],
  ];
  function probeErrorLabel(raw: string): string {
    for (const [re, prefix] of PROBE_ERROR_PREFIXES) {
      const m = raw.match(re);
      if (m) return `${t(prefix)} ${friendlyTransportError(m[1])}`;
    }
    return t(raw);
  }
  function friendlyTransportError(detail: string): string {
    if (/fetch failed|failed to fetch|network|ECONN|ENOTFOUND|timeout/i.test(detail)) {
      return t('could not connect to Meta');
    }
    return t(detail);
  }
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
      // remains accurate. The token columns are not readable by the
      // browser (migration 076); the form shows a masked placeholder.
      const { data, error } = await supabase
        .from('whatsapp_config')
        .select('id, user_id, phone_number_id, waba_id, status, connected_at, registered_at, subscribed_apps_at, last_registration_error, created_at, updated_at')
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

          if (!res.ok) {
            // 401 / 429: not a verdict on the connection — keep the
            // current status and just tell the user.
            toast.error(t(payload?.error || 'API connection failed'));
          } else if (payload.connected) {
            setConnectionStatus('connected');
            setResetReason(null);
            setStatusMessage('');
            setStatusMeta(null);
            setWabaSubscription(payload.waba_subscription ?? null);
          } else {
            setConnectionStatus('disconnected');
            setResetReason(payload.needs_reset ? 'token_corrupted' : payload.reason === 'meta_api_error' ? 'meta_api_error' : null);
            setStatusMessage(localized(payload.message, payload.message_pt));
            setStatusMeta(payload.meta ?? null);
            setWabaSubscription(null);
          }
        } catch (err) {
          console.error('Health check failed:', err);
          setConnectionStatus('disconnected');
        }
      } else {
        setConnectionStatus('disconnected');
        setResetReason(null);
        setStatusMessage('');
        setStatusMeta(null);
        setWabaSubscription(null);
      }
    } catch (err) {
      console.error('fetchConfig error:', err);
      toast.error(t('Failed to load WhatsApp configuration'));
    } finally {
      setLoading(false);
    }
  }, [supabase, t, localized]);

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
    if (!META_ID_RE.test(phoneNumberId.trim())) {
      toast.error(t(PHONE_ID_NOT_NUMERIC));
      return;
    }
    if (wabaId.trim() && !META_ID_RE.test(wabaId.trim())) {
      toast.error(t(WABA_ID_NOT_NUMERIC));
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
        // The route names the failing step and which field to check
        // (wacrm #505). Keep the details on screen — a toast is too
        // short-lived to copy a trace id out of.
        const message = data.error_pt || data.meta
          ? localized(data.error, data.error_pt)
          : t(data.error || 'Failed to save configuration');
        setSaveFailure({ message, meta: data.meta ?? null });
        toast.error(message || t('Failed to save configuration'), { duration: 10000 });
        setSaving(false);
        return;
      }
      setSaveFailure(null);
      const warning: MetaFailure | null = data.warning
        ? {
            message: localized(data.warning.error, data.warning.error_pt),
            meta: data.warning.meta ?? null,
          }
        : null;
      setSaveWarning(warning);
      if (warning) {
        toast.warning(`${t(SAVED_WITH_WARNING)}: ${warning.message}`, { duration: 12000 });
      }

      // The route now returns a structured outcome:
      //   * registered=true   → number is live, events will flow
      //   * registered=false  → credentials saved but /register
      //                         failed; UI shows the specific error
      //                         and a retry path. registration_error
      //                         is human-readable from Meta.
      if (data.registered === false && data.registration_error) {
        const reason = localized(data.registration_error, data.error_pt);
        setSaveFailure({
          message: `${t("Saved, but Meta couldn't register the number")}: ${reason}`,
          meta: data.meta ?? null,
        });
        toast.error(
          `${t("Saved, but Meta couldn't register the number")}: ${reason}`,
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

      if (!res.ok) {
        toast.error(t(payload?.error || 'API connection failed'));
        return;
      }
      if (payload.connected) {
        setConnectionStatus('connected');
        setResetReason(null);
        setStatusMessage('');
        setStatusMeta(null);
        setWabaSubscription(payload.waba_subscription ?? null);
        toast.success(
          payload.phone_info?.verified_name
            ? `${t('Connected to')} ${payload.phone_info.verified_name}`
            : t('API connection successful')
        );
      } else {
        setConnectionStatus('disconnected');
        setResetReason(payload.needs_reset ? 'token_corrupted' : payload.reason === 'meta_api_error' ? 'meta_api_error' : null);
        const message = localized(payload.message, payload.message_pt);
        setStatusMessage(message);
        setStatusMeta(payload.meta ?? null);
        setWabaSubscription(null);
        toast.error(message || t('API connection failed'), { duration: 10000 });
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
      const body = (await res.json().catch(() => null)) as
        | (RegistrationProbe & { error?: string })
        | null;
      // 403 (non-admin) / 429 answer `{ error }` without `checks` —
      // never hand that to the probe panel.
      if (!res.ok || !body || typeof body.checks !== 'object' || body.checks === null) {
        toast.error(t(body?.error || 'Could not reach the verification endpoint.'));
        return;
      }
      const data = body;
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
      setStatusMeta(null);
      setSaveFailure(null);
      setSaveWarning(null);
      setWabaSubscription(null);
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
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const showResetBanner = resetReason === 'token_corrupted';

  // Step + code + trace id in small muted text, so a user can quote
  // them to Meta support (wacrm #505). Labels are dictionary keys in
  // their own nodes; the values (ids, Meta's English text) are not.
  const renderMetaDetails = (meta: MetaErrorMeta) => (
    <div className="mt-2 space-y-0.5 text-[11px] leading-relaxed text-muted-foreground break-all">
      <p>
        <span>{t('Step')}</span>:{' '}
        <span>{t(META_STEP_LABELS[meta.step] ?? meta.step)}</span>
        {meta.code !== null && meta.code !== undefined && (
          <>
            {' · '}
            <span>{t('Meta error code')}</span>:{' '}
            <code data-no-translate>
              {meta.code}
              {meta.subcode !== null && meta.subcode !== undefined ? `/${meta.subcode}` : ''}
            </code>
          </>
        )}
        {meta.fbtrace_id && (
          <>
            {' · '}
            <span>{t('Trace ID')}</span>: <code data-no-translate>{meta.fbtrace_id}</code>
          </>
        )}
      </p>
      {meta.message && (
        <p>
          <span>{t('Meta said')}</span>: <span data-no-translate>{meta.message}</span>
        </p>
      )}
      <p>{t('Quote these details when contacting Meta support.')}</p>
    </div>
  );

  const copy = COPY[language] ?? COPY['pt-BR'];

  return (
      <div className="space-y-8">
      {/* Main config form */}
      <div className="space-y-8">
        {/* Corrupted-token reset banner */}
        {showResetBanner && (
          <div role="alert" className="flex items-start gap-2.5">
              <AlertTriangle className="size-4 text-amber-500 mt-0.5 shrink-0" aria-hidden="true" />
              <div className="flex-1">
                <p className="text-sm font-medium text-foreground">
                  {t("Stored token can't be decrypted")}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {statusMessage}
                </p>
                <Button
                  onClick={handleReset}
                  disabled={resetting || !canEditSettings}
                  size="sm"
                  variant="outline"
                  className="mt-3"
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
        )}

        {/* Last save failed — why, which field, and what to quote to Meta */}
        {saveFailure && (
          <div role="alert" className="flex items-start gap-2.5">
              <XCircle className="size-4 text-red-500 mt-0.5 shrink-0" aria-hidden="true" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">{t('Last save failed')}</p>
                <p className="mt-1 text-sm text-muted-foreground" data-no-translate>
                  {saveFailure.message}
                </p>
                {saveFailure.meta && renderMetaDetails(saveFailure.meta)}
              </div>
          </div>
        )}

        {/* Saved, but a non-fatal Meta step failed */}
        {saveWarning && (
          <div role="status" className="flex items-start gap-2.5">
              <AlertTriangle className="size-4 text-amber-500 mt-0.5 shrink-0" aria-hidden="true" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">{t(SAVED_WITH_WARNING)}</p>
                <p className="mt-1 text-sm text-muted-foreground" data-no-translate>
                  {saveWarning.message}
                </p>
                {saveWarning.meta && renderMetaDetails(saveWarning.meta)}
              </div>
          </div>
        )}

        <SettingsGroup title={t('Status')}>
        <div className="divide-y divide-border">
        {/* Connection Status */}
        <div className="pb-3">
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            <StatusDot tone={connectionStatus === 'connected' ? 'ok' : 'bad'} />
            {connectionStatus === 'connected' ? t('Credentials valid') : t('Not Connected')}
          </p>
          <p className="mt-1 pl-3.5 text-sm text-muted-foreground">
            {connectionStatus === 'connected'
              ? t('Your access token authenticates with Meta. See Registration status below for whether webhooks are actually wired.')
              : statusMessage ||
                t('Configure your Meta API credentials below to connect your WhatsApp Business account.')}
          </p>
          {connectionStatus === 'connected' && wabaSubscription?.checked && (() => {
            const notice = subscriptionNotice(wabaSubscription);
            return (
              <p
                className={cn(
                  'mt-1 flex items-start gap-1.5 pl-3.5 text-xs text-muted-foreground',
                  (notice === 'not_subscribed' || notice === 'other_app') && 'text-foreground',
                )}
              >
                {(notice === 'not_subscribed' || notice === 'other_app') && (
                  <StatusDot tone="warn" className="mt-1.5" />
                )}
                {notice === 'not_subscribed'
                  ? t(WABA_NOT_SUBSCRIBED)
                  : notice === 'other_app'
                    ? t(WABA_OTHER_APP)
                    : notice === 'subscribed'
                      ? t(WABA_SUBSCRIBED)
                      : localized(wabaSubscription.error, wabaSubscription.error_pt)}
              </p>
            );
          })()}
          {connectionStatus !== 'connected' && statusMeta && (
            <div className="pl-3.5">{renderMetaDetails(statusMeta)}</div>
          )}
        </div>

        {/* Registration Status — the "is it actually live?" check.
            Credentials being valid is necessary but not sufficient;
            without a successful /register call the number won't
            receive inbound events. Surface this dimension separately
            so users don't trust a misleading green banner. */}
        {config && (
          <div className="pt-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                <StatusDot tone={isRegistered ? 'ok' : 'warn'} />
                  {isRegistered
                    ? t('Registered — Meta will deliver events to SempreCRM')
                    : t('Not registered — Meta will not deliver events')}
              </p>
              {canEditSettings && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleVerifyRegistration}
                  disabled={verifyingRegistration}
                >
                  {verifyingRegistration ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Zap className="size-3.5" />
                  )}
                  {t('Verify with Meta')}
                </Button>
              )}
            </div>
            <p className="text-muted-foreground mt-1 pl-3.5 text-xs leading-relaxed">
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
                  <span className="text-foreground">
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
            </p>

            {registrationProbe && (
              <div className="mt-3 ml-3.5 rounded-md bg-muted/50 px-3 py-2 space-y-1.5 text-[11px]">
                <p className="flex items-center gap-1.5 font-medium text-foreground">
                  {t('Diagnostic — last run:')}{' '}
                  <StatusDot tone={registrationProbe.live ? 'ok' : 'warn'} />
                  <span>
                    {registrationProbe.live ? t('live') : t('not live')}
                  </span>
                </p>
                <ul className="space-y-0.5 text-muted-foreground">
                  {Object.entries(registrationProbe.checks).map(([k, v]) => (
                    <li key={k} className="flex items-center gap-1.5">
                      {v === true ? (
                        <CheckCircle2 className="size-3 text-emerald-500 shrink-0" />
                      ) : v === false ? (
                        <XCircle className="size-3 text-red-500 shrink-0" />
                      ) : (
                        <span className="size-3 rounded-full border border-border shrink-0" />
                      )}
                      <span className="text-muted-foreground">
                        {t(PROBE_CHECK_LABELS[k] ?? k)}
                      </span>
                    </li>
                  ))}
                </ul>
                {(registrationProbe.errors ?? []).length > 0 && (
                  <ul className="pt-1 space-y-0.5 text-foreground">
                    {registrationProbe.errors?.map((e, i) => (
                      <li key={i}>• {probeErrorLabel(e)}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
        </div>
        </SettingsGroup>

        {/* API Credentials */}
        <SettingsGroup
          title={t('API Credentials')}
          description={t('Enter your Meta WhatsApp Business API credentials.')}
        >
          <div className="space-y-4">
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
          </div>
        </SettingsGroup>

        {/* Webhook URL */}
        <SettingsGroup
          title={t('Webhook Configuration')}
          description={t('Use this URL as your webhook callback in the Meta App Dashboard.')}
        >
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
                  className="shrink-0"
                >
                  <Copy className="size-4" />
                </Button>
              </div>
            </div>
        </SettingsGroup>

        {/* Action Buttons */}
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={handleSave}
            disabled={saving || !canEditSettings}
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
        </div>
      </div>

      {/* Setup Instructions */}
      <SettingsGroup
        title={t('Setup Instructions')}
        description={t('Follow these steps to connect your WhatsApp Business API.')}
      >
        <div>
            <Accordion>
              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground tabular-nums">1</span>
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
                    <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground tabular-nums">2</span>
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
                    <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground tabular-nums">3</span>
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
                    <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground tabular-nums">4</span>
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
        </div>
      </SettingsGroup>

      {config && canEditSettings && (
        <SettingsDangerZone title={copy.danger} className="mt-0">
          <Button
            variant="ghost"
            size="sm"
            className={DANGER_TEXT_BUTTON}
            onClick={handleReset}
            disabled={resetting}
          >
            {resetting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                {t('Resetting...')}
              </>
            ) : (
              <>
                <RotateCcw className="size-3.5" />
                {t('Reset Configuration')}
              </>
            )}
          </Button>
        </SettingsDangerZone>
      )}
    </div>
  );
}
