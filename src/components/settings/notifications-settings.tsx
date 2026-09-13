'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bell, BellOff, BellRing, Laptop, Loader2, Smartphone, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import {
  getCurrentSubscription,
  getPermissionState,
  subscribePush,
  unsubscribePush,
  vapidPublicKey,
  type PushPermission,
} from '@/lib/push/client';
import {
  PUSH_EVENT_KINDS,
  PUSH_EVENT_LABELS,
  parseNotificationPrefs,
  type NotificationPrefs,
  type PushEventKind,
} from '@/lib/push/prefs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';

import { SettingsPanelHead } from './settings-panel-head';

interface SubscriptionRow {
  id: string;
  endpoint: string;
  user_agent: string | null;
  created_at: string;
  last_used_at: string | null;
}

/** "Chrome · Windows"-style label from a user agent string. */
function describeDevice(ua: string | null): { label: string; mobile: boolean } {
  if (!ua) return { label: 'Unknown browser', mobile: false };
  const mobile = /Mobile|Android|iPhone|iPad/i.test(ua);
  let browser = 'Browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua)) browser = 'Opera';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  let os = '';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad/.test(ua)) os = 'iOS';
  else if (/Mac OS/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  return { label: os ? `${browser} · ${os}` : browser, mobile };
}

/**
 * Settings → Notificações (spec round 2 §5): enable browser push in this
 * browser, list the devices already enabled (with remove), and toggle
 * which event kinds reach the user (`profiles.notification_prefs`).
 */
export function NotificationsSettings() {
  const supabase = useMemo(() => createClient(), []);
  const { t, language } = useLanguage();
  const { user, profile, profileLoading, refreshProfile } = useAuth();

  const [permission, setPermission] = useState<PushPermission>('unsupported');
  const [thisBrowserEndpoint, setThisBrowserEndpoint] = useState<string | null>(null);
  const [subs, setSubs] = useState<SubscriptionRow[] | null>(null);
  const [configured, setConfigured] = useState<boolean>(!!vapidPublicKey());
  const [busy, setBusy] = useState<'enable' | 'disable' | string | null>(null);
  const [prefs, setPrefs] = useState<NotificationPrefs>(() =>
    parseNotificationPrefs(profile?.notification_prefs),
  );
  const [savingPref, setSavingPref] = useState<PushEventKind | null>(null);

  useEffect(() => {
    setPrefs(parseNotificationPrefs(profile?.notification_prefs));
  }, [profile?.notification_prefs]);

  const refreshLocal = useCallback(async () => {
    setPermission(getPermissionState());
    const sub = await getCurrentSubscription();
    setThisBrowserEndpoint(sub?.endpoint ?? null);
  }, []);

  const loadSubs = useCallback(async () => {
    try {
      const res = await fetch('/api/push/subscriptions', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { subscriptions: SubscriptionRow[]; configured: boolean };
      setSubs(body.subscriptions ?? []);
      setConfigured(!!body.configured && !!vapidPublicKey());
    } catch (err) {
      console.error('[notifications] load failed:', err);
      setSubs([]);
    }
  }, []);

  useEffect(() => {
    void refreshLocal();
    void loadSubs();
  }, [refreshLocal, loadSubs]);

  const enabledHere = permission === 'granted' && !!thisBrowserEndpoint;

  async function enableHere() {
    setBusy('enable');
    try {
      const result = await subscribePush();
      if (result.ok) {
        toast.success(t('Notifications enabled in this browser'));
      } else if (result.reason === 'denied') {
        toast.error(t('Permission denied — allow notifications for this site in your browser settings.'));
      } else if (result.reason === 'unsupported') {
        toast.error(t('This browser does not support push notifications.'));
      } else if (result.reason === 'no_vapid_key') {
        toast.error(t('Push is not configured on this server.'));
      } else {
        toast.error(t('Could not enable notifications'));
      }
    } finally {
      await refreshLocal();
      await loadSubs();
      setBusy(null);
    }
  }

  async function disableHere() {
    setBusy('disable');
    try {
      await unsubscribePush();
      toast.success(t('Notifications disabled in this browser'));
    } finally {
      await refreshLocal();
      await loadSubs();
      setBusy(null);
    }
  }

  async function removeDevice(row: SubscriptionRow) {
    setBusy(row.id);
    try {
      if (row.endpoint === thisBrowserEndpoint) {
        await unsubscribePush();
      } else {
        const res = await fetch('/api/push/subscriptions', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: row.id }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
      toast.success(t('Device removed'));
    } catch (err) {
      console.error('[notifications] remove failed:', err);
      toast.error(t('Could not remove the device'));
    } finally {
      await refreshLocal();
      await loadSubs();
      setBusy(null);
    }
  }

  async function togglePref(kind: PushEventKind, value: boolean) {
    if (!user) return;
    const next = { ...prefs, [kind]: value };
    setPrefs(next);
    setSavingPref(kind);
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ notification_prefs: next })
        .eq('user_id', user.id);
      if (error) throw error;
      await refreshProfile();
    } catch (err) {
      console.error('[notifications] pref save failed:', err);
      toast.error(t('Could not save the preference'));
      setPrefs(prefs);
    } finally {
      setSavingPref(null);
    }
  }

  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }),
    [language],
  );

  return (
    <section className="max-w-4xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t('Notifications')}
        description={t(
          'Get a browser notification when a customer writes, a conversation or task is assigned to you, or a task is about to be due — even with the tab closed.',
        )}
      />

      <div className="grid gap-4">
        {/* This browser ------------------------------------------------ */}
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <CardTitle className="flex items-center gap-2 text-foreground">
                  {enabledHere ? (
                    <BellRing className="size-4 text-primary" />
                  ) : (
                    <Bell className="size-4 text-primary" />
                  )}
                  {t('This browser')}
                </CardTitle>
                <CardDescription className="mt-1 text-muted-foreground">
                  {enabledHere
                    ? t('Notifications are on in this browser.')
                    : permission === 'denied'
                      ? t('Notifications are blocked for this site. Allow them in the browser settings, then try again.')
                      : permission === 'unsupported'
                        ? t('This browser does not support push notifications.')
                        : t('Turn on notifications here — the browser will ask for permission.')}
                </CardDescription>
              </div>
              <div className="shrink-0">
                {enabledHere ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={disableHere}
                    disabled={busy !== null}
                  >
                    {busy === 'disable' ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <BellOff className="size-3.5" />
                    )}
                    {t('Turn off here')}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={enableHere}
                    disabled={
                      busy !== null ||
                      !configured ||
                      permission === 'denied' ||
                      permission === 'unsupported'
                    }
                    className="bg-primary text-primary-foreground hover:bg-primary/90"
                  >
                    {busy === 'enable' ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <BellRing className="size-3.5" />
                    )}
                    {t('Enable in this browser')}
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>
          {!configured ? (
            <CardContent>
              <Alert className="border-border bg-card">
                <AlertTitle className="mb-1 text-foreground">{t('Push is not configured on this server.')}</AlertTitle>
                <AlertDescription className="text-sm text-muted-foreground">
                  {t('Ask the administrator to set the VAPID keys (see .env.local.example).')}
                </AlertDescription>
              </Alert>
            </CardContent>
          ) : null}
        </Card>

        {/* Devices ----------------------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t('Devices')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('Every browser where you turned notifications on. Remove one to stop sending there.')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {subs === null || profileLoading ? (
              <div className="space-y-2">
                {[1, 2].map((i) => (
                  <div key={i} className="h-12 animate-pulse rounded-lg bg-muted/60" />
                ))}
              </div>
            ) : subs.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('No devices yet.')}</p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {subs.map((row) => {
                  const device = describeDevice(row.user_agent);
                  const Icon = device.mobile ? Smartphone : Laptop;
                  const isThis = row.endpoint === thisBrowserEndpoint;
                  return (
                    <li key={row.id} className="flex items-center gap-3 px-3 py-2.5">
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">
                          {t(device.label)}
                          {isThis ? (
                            <span className="ml-2 rounded-full border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                              {t('this browser')}
                            </span>
                          ) : null}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {t('Added on')} {dateFmt.format(new Date(row.created_at))}
                          {row.last_used_at
                            ? ` · ${t('last notified')} ${dateFmt.format(new Date(row.last_used_at))}`
                            : ''}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('Remove device')}
                        title={t('Remove device')}
                        onClick={() => removeDevice(row)}
                        disabled={busy !== null}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        {busy === row.id ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Trash2 className="size-4" />
                        )}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Event kinds -------------------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t('What to notify')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('Applies to all your devices. You are never notified about a conversation you have open on screen.')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border">
              {PUSH_EVENT_KINDS.map((kind) => {
                const meta = PUSH_EVENT_LABELS[kind];
                return (
                  <li key={kind} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">{t(meta.title)}</p>
                      <p className="text-xs text-muted-foreground">{t(meta.description)}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {savingPref === kind ? (
                        <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                      ) : null}
                      <Switch
                        checked={prefs[kind]}
                        disabled={profileLoading || savingPref !== null}
                        onCheckedChange={(v) => togglePref(kind, !!v)}
                        aria-label={t(meta.title)}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
