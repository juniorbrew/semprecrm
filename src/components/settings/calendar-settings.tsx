'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle, ExternalLink, Link2, Link2Off, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { useEntitlements } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import { CALENDAR_PROVIDERS, PROVIDER_LABELS } from '@/lib/calendar/sync/config';
import type { CalendarConnectionPublic, CalendarProvider } from '@/types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { ProviderIcon } from '@/components/calendar/provider-icon';

import { SettingsPanelHead } from './settings-panel-head';
import { SettingsChip, StatusDot } from './settings-chip';

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

  return (
    <section className="max-w-4xl animate-in fade-in-50 duration-200">
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
        <Alert className="mb-4 border-border bg-card">
          <AlertTitle className="mb-1 text-foreground">{t('Not included in your plan')}</AlertTitle>
          <AlertDescription className="text-sm text-muted-foreground">
            {t('The calendar module is not included in your plan.')}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4">
        {CALENDAR_PROVIDERS.map((provider) => {
          const conn = byProvider(provider);
          const configured = !!data?.configured[provider];
          const loading = data === null;
          const label = PROVIDER_LABELS[provider];
          const connected = !!conn && conn.status !== 'revoked';
          const connectHref = `/api/integrations/${provider}/connect`;
          return (
            <Card key={provider}>
              <CardHeader>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <CardTitle className="flex items-center gap-2 text-foreground">
                      <ProviderIcon provider={provider} className="h-4 w-4" />
                      {label}
                      {loading ? null : conn ? (
                        conn.status === 'active' ? (
                          <SettingsChip variant="ok">
                            <StatusDot tone="ok" /> {t('Connected')}
                          </SettingsChip>
                        ) : conn.status === 'error' ? (
                          <SettingsChip variant="warn">
                            <AlertTriangle /> {t('Error')}
                          </SettingsChip>
                        ) : (
                          <SettingsChip variant="warn">
                            <Link2Off /> {t('Reconnect')}
                          </SettingsChip>
                        )
                      ) : null}
                    </CardTitle>
                    <CardDescription className="mt-1 text-muted-foreground">
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
                    </CardDescription>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {conn ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => disconnect(provider)}
                        disabled={busy !== null || loading}
                      >
                        {busy === `disconnect:${provider}` ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Link2Off className="size-3.5" />
                        )}
                        {t('Disconnect')}
                      </Button>
                    ) : null}
                    {connected ? null : !loading && configured && !moduleOff ? (
                      // A plain anchor: the connect route answers with a
                      // 302 to the provider's consent screen.
                      <a
                        href={connectHref}
                        className={buttonVariants({
                          size: 'sm',
                          className: 'bg-primary text-primary-foreground hover:bg-primary/90',
                        })}
                      >
                        <Link2 className="size-3.5" />
                        {conn ? t('Reconnect') : t('Connect')}
                      </a>
                    ) : (
                      <Button size="sm" disabled className="bg-primary text-primary-foreground">
                        <Link2 className="size-3.5" />
                        {conn ? t('Reconnect') : t('Connect')}
                      </Button>
                    )}
                  </div>
                </div>
              </CardHeader>

              {!loading && (!configured || conn?.last_error || conn) ? (
                <CardContent className="grid gap-3">
                  {!configured ? (
                    <Alert className="border-border bg-card">
                      <AlertTitle className="mb-1 text-foreground">{t('Integration not configured')}</AlertTitle>
                      <AlertDescription className="text-sm text-muted-foreground">
                        {provider === 'google'
                          ? t('The Google Agenda integration has not been set up by the server administrator yet.')
                          : t('The Outlook integration has not been set up by the server administrator yet.')}
                      </AlertDescription>
                    </Alert>
                  ) : null}

                  {conn?.status === 'revoked' ? (
                    <Alert className="border-amber-500/40 bg-amber-500/10">
                      <AlertTriangle className="size-4 text-amber-500" />
                      <AlertTitle className="mb-1 text-foreground">{t('Access revoked')}</AlertTitle>
                      <AlertDescription className="text-sm text-muted-foreground">
                        {t('The provider no longer accepts our access — reconnect to resume the sync.')}
                        {conn.last_error ? <span className="mt-1 block break-words text-xs opacity-80">{conn.last_error}</span> : null}
                      </AlertDescription>
                    </Alert>
                  ) : conn?.status === 'error' && conn.last_error ? (
                    <Alert className="border-amber-500/40 bg-amber-500/10">
                      <AlertTriangle className="size-4 text-amber-500" />
                      <AlertTitle className="mb-1 text-foreground">{t('Last sync failed')}</AlertTitle>
                      <AlertDescription className="text-sm text-muted-foreground">
                        <span className="break-words">{conn.last_error}</span>
                        <span className="mt-1 block text-xs opacity-80">{t('It will be retried automatically every 5 minutes.')}</span>
                      </AlertDescription>
                    </Alert>
                  ) : null}

                  {conn ? (
                    <label className="flex items-start justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
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
                </CardContent>
              ) : null}
            </Card>
          );
        })}

        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ExternalLink className="size-3" />
          {t('Only the title, description, location and time of an appointment are shared with the provider. Links to contacts, deals and tasks stay here.')}
        </p>
      </div>
    </section>
  );
}
