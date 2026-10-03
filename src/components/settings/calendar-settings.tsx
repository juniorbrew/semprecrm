'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ExternalLink, Link2, Link2Off, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { useEntitlements } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import { CALENDAR_PROVIDERS, PROVIDER_LABELS } from '@/lib/calendar/sync/config';
import type { CalendarConnectionPublic, CalendarProvider } from '@/types';
import type { Language } from '@/lib/i18n';
import { Button, buttonVariants } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { ProviderIcon } from '@/components/calendar/provider-icon';

import { SettingsPanelHead } from './settings-panel-head';
import { SettingsChip, StatusDot } from './settings-chip';
import { DANGER_TEXT_BUTTON, SettingsDangerZone, SettingsGroup } from './settings-group';

const COPY: Record<Language, { dangerZone: string }> = {
  'pt-BR': { dangerZone: 'Zona de risco' },
  'en-US': { dangerZone: 'Danger zone' },
};

interface ConnectionsPayload {
  configured: Record<CalendarProvider, boolean>;
  connections: CalendarConnectionPublic[];
}

interface SyncPayload {
  connections: number;
  synced: number;
  errors: number;
  revoked: number;
  results: { provider: CalendarProvider; status: string; error: string | null; pulled_created: number; pushed_created: number }[];
}

/** `?error=` codes the OAuth routes send back (src/lib/calendar/sync/oauth.ts). */
const OAUTH_ERRORS: Record<string, string> = {
  not_configured: 'This integration is not configured on this server.',
  module: 'The calendar module is not included in your plan.',
  denied: 'You cancelled the authorization on the provider.',
  state: 'The authorization link expired or was tampered with. Try again.',
  exchange: 'The provider did not accept the authorization code. Try again.',
  provider: 'The provider returned an error. Try again.',
  unauthorized: 'Sign in again and retry the connection.',
};

/**
 * Settings → Agenda (spec "Fase 2 — Configurações → Agenda"): one card
 * per provider (Google Calendar, Outlook) with connect / disconnect,
 * the connected e-mail, the last sync, the error state, the
 * "mirror appointments I attend" toggle and "Sync now".
 */
export function CalendarSettings() {
  const { t, language } = useLanguage();
  const copy = COPY[language] ?? COPY['pt-BR'];
  const router = useRouter();
  const searchParams = useSearchParams();
  const { ready: entitlementsReady, modules } = useEntitlements();

  const [data, setData] = useState<ConnectionsPayload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/integrations/calendar/connections', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as ConnectionsPayload);
    } catch (err) {
      console.error('[calendar-settings] load failed:', err);
      setData({ configured: { google: false, microsoft: false }, connections: [] });
      toast.error(t('Failed to load the calendar connections'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Feedback from the OAuth redirect (`?connected=` / `?error=`), then
  // clean the URL so a refresh does not repeat the toast.
  useEffect(() => {
    const connected = searchParams.get('connected');
    const error = searchParams.get('error');
    if (!connected && !error) return;
    if (connected === 'google' || connected === 'microsoft') {
      toast.success(`${t(PROVIDER_LABELS[connected])}: ${t('connected')}`);
    } else if (error) {
      toast.error(t(OAUTH_ERRORS[error] ?? OAUTH_ERRORS.provider));
    }
    const params = new URLSearchParams(searchParams.toString());
    params.delete('connected');
    params.delete('error');
    params.delete('provider');
    router.replace(`/settings?${params.toString()}`, { scroll: false });
  }, [searchParams, router, t]);

  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'short' }),
    [language],
  );

  const connections = data?.connections ?? [];
  const byProvider = (p: CalendarProvider) => connections.find((c) => c.provider === p) ?? null;
  const anyConnected = connections.some((c) => c.status !== 'revoked');

  async function disconnect(provider: CalendarProvider) {
    setBusy(`disconnect:${provider}`);
    try {
      const res = await fetch(`/api/integrations/${provider}/disconnect`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success(`${t(PROVIDER_LABELS[provider])}: ${t('disconnected')}`);
      await load();
    } catch (err) {
      console.error('[calendar-settings] disconnect failed:', err);
      toast.error(t('Could not disconnect'));
    } finally {
      setBusy(null);
    }
  }

  async function toggleMirror(provider: CalendarProvider, value: boolean) {
    const prev = data;
    setData((d) =>
      d
        ? { ...d, connections: d.connections.map((c) => (c.provider === provider ? { ...c, mirror_attending: value } : c)) }
        : d,
    );
    setBusy(`mirror:${provider}`);
    try {
      const res = await fetch('/api/integrations/calendar/connections', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, mirror_attending: value }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.error('[calendar-settings] mirror toggle failed:', err);
      toast.error(t('Could not save the preference'));
      setData(prev);
    } finally {
      setBusy(null);
    }
  }

  async function syncNow() {
    setBusy('sync');
    try {
      const res = await fetch('/api/integrations/calendar/sync/me', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as SyncPayload;
      if (body.connections === 0) toast.message(t('Nothing to sync'));
      else if (body.errors === 0 && body.revoked === 0) toast.success(t('Calendars synced'));
      else toast.error(t('Some calendars could not be synced — see the cards below'));
      await load();
    } catch (err) {
      console.error('[calendar-settings] sync failed:', err);
      toast.error(t('Could not sync now'));
    } finally {
      setBusy(null);
    }
  }

  const moduleOff = entitlementsReady && !modules.calendar;
  const disconnectable = CALENDAR_PROVIDERS.filter((p) => byProvider(p));

  return (
    <section className="max-w-2xl">
      <SettingsPanelHead
        title={t('Calendar')}
        description={t(
          'Connect your Google Calendar or Outlook: appointments you create here appear there, and events from there appear on your agenda. Each member connects their own account.',
        )}
        action={
          anyConnected ? (
            <Button variant="outline" size="sm" onClick={syncNow} disabled={busy !== null}>
              {busy === 'sync' ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              {t('Sync now')}
            </Button>
          ) : null
        }
      />

      {moduleOff ? (
        <div className="mb-6">
          <NoticeLine title={t('Not included in your plan')}>
            {t('The calendar module is not included in your plan.')}
          </NoticeLine>
        </div>
      ) : null}

      <div className="space-y-8">
        {CALENDAR_PROVIDERS.map((provider) => {
          const conn = byProvider(provider);
          const configured = !!data?.configured[provider];
          const loading = data === null;
          const label = PROVIDER_LABELS[provider];
          const connected = !!conn && conn.status !== 'revoked';
          const connectHref = `/api/integrations/${provider}/connect`;
          return (
            <SettingsGroup
              key={provider}
              title={
                <>
                  <ProviderIcon provider={provider} className="size-3.5" />
                  {label}
                </>
              }
              description={
                <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  {loading ? null : conn ? (
                    conn.status === 'active' ? (
                      <SettingsChip variant="ok">{t('Connected')}</SettingsChip>
                    ) : conn.status === 'error' ? (
                      <SettingsChip variant="warn">{t('Error')}</SettingsChip>
                    ) : (
                      <SettingsChip variant="warn">{t('Reconnect')}</SettingsChip>
                    )
                  ) : null}
                  <span className="min-w-0">
                    {loading
                      ? t('Loading…')
                      : conn
                        ? `${conn.email ?? '—'}${
                            conn.last_sync_at
                              ? ` · ${t('Last sync')} ${dateFmt.format(new Date(conn.last_sync_at))}`
                              : ` · ${t('Not synced yet')}`
                          }`
                        : provider === 'google'
                            ? t('Two-way sync with the primary calendar of your Google account.')
                            : t('Two-way sync with the default calendar of your Microsoft account.')}
                  </span>
                </span>
              }
              action={
                connected ? null : !loading && configured && !moduleOff ? (
                  // A plain anchor: the connect route answers with a
                  // 302 to the provider's consent screen.
                  <a href={connectHref} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                    <Link2 className="size-3.5" />
                    {conn ? t('Reconnect') : t('Connect')}
                  </a>
                ) : (
                  <Button variant="outline" size="sm" disabled>
                    <Link2 className="size-3.5" />
                    {conn ? t('Reconnect') : t('Connect')}
                  </Button>
                )
              }
            >
              {!loading && !configured ? (
                <NoticeLine tone="muted" title={t('Integration not configured')}>
                  {provider === 'google'
                    ? t('The Google Agenda integration has not been set up by the server administrator yet.')
                    : t('The Outlook integration has not been set up by the server administrator yet.')}
                </NoticeLine>
              ) : null}

              {loading ? null : conn?.status === 'revoked' ? (
                <NoticeLine title={t('Access revoked')}>
                  {t('The provider no longer accepts our access — reconnect to resume the sync.')}
                  {conn.last_error ? <span className="mt-1 block break-words text-xs">{conn.last_error}</span> : null}
                </NoticeLine>
              ) : conn?.status === 'error' && conn.last_error ? (
                <NoticeLine title={t('Last sync failed')}>
                  <span className="break-words">{conn.last_error}</span>
                  <span className="mt-1 block text-xs">{t('It will be retried automatically every 5 minutes.')}</span>
                </NoticeLine>
              ) : null}

              {!loading && conn ? (
                <label className="flex items-start justify-between gap-4 py-1">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">
                      {t('Mirror appointments where I am an attendee')}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {t(
                        'Besides the appointments you own, also send the ones you were added to (when their owner has no calendar connected).',
                      )}
                    </span>
                  </span>
                  <Switch
                    checked={conn.mirror_attending}
                    onCheckedChange={(v) => toggleMirror(provider, !!v)}
                    disabled={busy !== null}
                    aria-label={t('Mirror appointments where I am an attendee')}
                  />
                </label>
              ) : null}
            </SettingsGroup>
          );
        })}

        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ExternalLink className="size-3" />
          {t('Only the title, description, location and time of an appointment are shared with the provider. Links to contacts, deals and tasks stay here.')}
        </p>
      </div>

      {disconnectable.length > 0 ? (
        <SettingsDangerZone title={copy.dangerZone}>
          {disconnectable.map((provider) => (
            <div key={provider}>
            <Button
              variant="ghost"
              size="sm"
              className={DANGER_TEXT_BUTTON}
              onClick={() => disconnect(provider)}
              disabled={busy !== null || data === null}
            >
              {busy === `disconnect:${provider}` ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Link2Off className="size-3.5" />
              )}
              {t('Disconnect')} {PROVIDER_LABELS[provider]}
            </Button>
            </div>
          ))}
        </SettingsDangerZone>
      ) : null}
    </section>
  );
}

/** Plain notice line: status dot + bold lead + muted text, no box. */
function NoticeLine({
  title,
  tone = 'warn',
  children,
}: {
  title: ReactNode;
  tone?: 'warn' | 'muted';
  children: ReactNode;
}) {
  return (
    <div className="flex gap-2.5 text-sm">
      <StatusDot tone={tone} className="mt-[7px]" />
      <div className="min-w-0 text-muted-foreground">
        <span className="font-medium text-foreground">{title}</span>{' '}
        {children}
      </div>
    </div>
  );
}
