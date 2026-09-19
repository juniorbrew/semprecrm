'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  LogOut,
  QrCode,
  RefreshCw,
  Smartphone,
  Unplug,
} from 'lucide-react';

import { useLanguage } from '@/hooks/use-language';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SettingsChip, type ChipVariant } from './settings-chip';
import type { WaQrSessionStatus } from '@/types';

/** Shape of `session` in every /api/channels/qr/* response. */
interface QrSessionView {
  status: WaQrSessionStatus;
  qr?: string | null;
  phone?: string | null;
  name?: string | null;
  phone_number?: string | null;
  display_name?: string | null;
  connected_at?: string | null;
  last_error?: string | null;
  error?: string | null;
}

type GatewayProblem = 'gateway_unconfigured' | 'gateway_unreachable' | 'module_not_included' | null;

const POLL_MS = 2_000;

const STATUS_CHIP: Record<WaQrSessionStatus, ChipVariant> = {
  disconnected: 'muted',
  qr: 'admin',
  connecting: 'warn',
  connected: 'ok',
};

/**
 * Settings → WhatsApp → "WhatsApp via QR code".
 *
 * Talks only to `/api/channels/qr/{status,connect,logout}`. Polls
 * `status` every 2 s while the gateway is showing a QR or reconnecting
 * and stops as soon as the session settles. A 503 from the API turns
 * into a disabled state with the reason (env unset / gateway down)
 * instead of a crash.
 */
export function WhatsAppQrPanel() {
  const { t, language } = useLanguage();
  // Admin or owner — the API enforces the same rule (requireRole('admin')).
  const { canEditSettings: canManage } = useAuth();

  const [session, setSession] = useState<QrSessionView | null>(null);
  const [problem, setProblem] = useState<GatewayProblem>(null);
  const [problemMessage, setProblemMessage] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlightRef = useRef(false);

  const applyResponse = useCallback(
    async (res: Response): Promise<QrSessionView | null> => {
      let body: {
        session?: QrSessionView | null;
        error?: string;
        code?: string;
      } = {};
      try {
        body = await res.json();
      } catch {
        body = {};
      }

      if (res.ok) {
        setProblem(null);
        setProblemMessage('');
        if (body.session) setSession(body.session);
        return body.session ?? null;
      }

      if (res.status === 503 && (body.code === 'gateway_unconfigured' || body.code === 'gateway_unreachable')) {
        setProblem(body.code);
        setProblemMessage(body.error ?? '');
        // Keep the last row the API knows about so the user still sees
        // "was connected as X" while the gateway is down.
        if (body.session) setSession(body.session);
        return null;
      }
      if (res.status === 403 && body.code === 'module_not_included') {
        setProblem('module_not_included');
        setProblemMessage(body.error ?? '');
        return null;
      }
      if (res.status === 403 && body.code === 'plan_limit_reached') {
        toast.error(body.error ?? t('Plan limit reached'));
        return null;
      }
      toast.error(body.error ?? t('Something went wrong. Please try again.'));
      return null;
    },
    [t],
  );

  const fetchStatus = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const res = await fetch('/api/channels/qr/status', { cache: 'no-store' });
      await applyResponse(res);
    } catch (err) {
      console.error('[qr-panel] status fetch failed:', err);
      setProblem('gateway_unreachable');
      setProblemMessage(t('Could not reach the server. Check your connection and try again.'));
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [applyResponse, t]);

  // Initial load.
  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  // Poll only while there is something to wait for.
  const shouldPoll =
    problem === null && (session?.status === 'qr' || session?.status === 'connecting');
  useEffect(() => {
    if (!shouldPoll) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    pollRef.current = setInterval(() => void fetchStatus(), POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [shouldPoll, fetchStatus]);

  async function handleConnect() {
    setConnecting(true);
    try {
      const res = await fetch('/api/channels/qr/connect', { method: 'POST' });
      const next = await applyResponse(res);
      if (next?.status === 'connected') {
        toast.success(t('WhatsApp connected.'));
      }
    } catch (err) {
      console.error('[qr-panel] connect failed:', err);
      toast.error(t('Could not reach the server. Check your connection and try again.'));
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm(t('Disconnect this WhatsApp number? You will need to scan a new QR code to reconnect.'))) {
      return;
    }
    setDisconnecting(true);
    try {
      const res = await fetch('/api/channels/qr/logout', { method: 'POST' });
      const next = await applyResponse(res);
      if (next) toast.success(t('WhatsApp disconnected.'));
    } catch (err) {
      console.error('[qr-panel] logout failed:', err);
      toast.error(t('Could not reach the server. Check your connection and try again.'));
    } finally {
      setDisconnecting(false);
    }
  }

  const status: WaQrSessionStatus = session?.status ?? 'disconnected';
  const phone = session?.phone ?? session?.phone_number ?? null;
  const name = session?.name ?? session?.display_name ?? null;
  const statusLabel: Record<WaQrSessionStatus, string> = {
    disconnected: t('Disconnected'),
    qr: t('Waiting for scan'),
    connecting: t('Connecting'),
    connected: t('Connected'),
  };
  const disabled = problem !== null;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-6">
        {/* Risk notice — always visible, it is the point of this screen. */}
        <Alert className="border-amber-600/40 bg-amber-950/30">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-400" />
            <div className="flex-1">
              <AlertTitle className="mb-1 text-amber-200">{t('Unofficial channel — use with care')}</AlertTitle>
              <AlertDescription className="text-sm leading-relaxed text-amber-100/80">
                {t(
                  'The WhatsApp Web protocol is reverse-engineered (Baileys library). It is not official, it violates WhatsApp’s terms and the number can be banned, especially with bulk sending. Broadcasts and templates therefore stay exclusive to the official API; the QR channel is for 1:1 support and reply automations.',
                )}
              </AlertDescription>
            </div>
          </div>
        </Alert>

        {/* Gateway problems — the panel degrades instead of crashing. */}
        {problem === 'gateway_unconfigured' && (
          <Alert className="border-border bg-card">
            <div className="flex items-start gap-3">
              <Unplug className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <div>
                <AlertTitle className="mb-1 text-foreground">{t('Gateway not configured')}</AlertTitle>
                <AlertDescription className="text-sm text-muted-foreground">
                  {t(
                    'The QR channel needs the wa-gateway service. Set WA_GATEWAY_URL and WA_GATEWAY_SECRET on the server and restart the app.',
                  )}
                </AlertDescription>
              </div>
            </div>
          </Alert>
        )}
        {problem === 'gateway_unreachable' && (
          <Alert className="border-red-900/60 bg-red-950/30">
            <div className="flex items-start gap-3">
              <Unplug className="mt-0.5 size-5 shrink-0 text-red-400" />
              <div className="flex-1">
                <AlertTitle className="mb-1 text-red-200">{t('Gateway unreachable')}</AlertTitle>
                <AlertDescription className="text-sm text-red-100/80">
                  {problemMessage ||
                    t('Could not talk to the WhatsApp gateway. Check that the wa-gateway service is running.')}
                </AlertDescription>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3 border-border bg-transparent text-foreground hover:bg-muted"
                  onClick={() => void fetchStatus()}
                >
                  <RefreshCw className="size-3.5" />
                  {t('Try again')}
                </Button>
              </div>
            </div>
          </Alert>
        )}
        {problem === 'module_not_included' && (
          <Alert className="border-border bg-card">
            <AlertTitle className="mb-1 text-foreground">{t('Module not included in your plan')}</AlertTitle>
            <AlertDescription className="text-sm text-muted-foreground">
              {t('The QR channel is not part of your current plan. Get in touch with the SempreCRM team to add it.')}
            </AlertDescription>
          </Alert>
        )}

        {/* Session card */}
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-foreground">
                <Smartphone className="size-4 text-primary" />
                {t('WhatsApp Web session')}
              </CardTitle>
              <SettingsChip variant={STATUS_CHIP[status]}>{statusLabel[status]}</SettingsChip>
            </div>
            <CardDescription className="text-muted-foreground">
              {t('Scan the QR code with the phone that owns the number: WhatsApp → Linked devices → Link a device.')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {loading ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="size-6 animate-spin text-primary" />
              </div>
            ) : status === 'connected' ? (
              <div className="flex items-start gap-3 rounded-lg border border-emerald-700/50 bg-emerald-950/30 px-4 py-3">
                <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-400" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-emerald-200">
                    {t('Connected as')}{' '}
                    <span data-no-translate className="text-foreground">
                      {name || t('Unknown name')} · {phone || t('unknown number')}
                    </span>
                  </p>
                  {session?.connected_at && (
                    <p data-no-translate className="mt-0.5 text-xs text-muted-foreground">
                      {t('Since')} {new Date(session.connected_at).toLocaleString(language)}
                    </p>
                  )}
                </div>
              </div>
            ) : status === 'qr' && session?.qr ? (
              <div className="flex flex-col items-center gap-3 py-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- data: URL from the gateway */}
                <img
                  src={session.qr}
                  alt={t('WhatsApp QR code')}
                  width={264}
                  height={264}
                  className="size-[264px] rounded-lg border border-border bg-white p-2"
                />
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  {t('The code refreshes automatically. Waiting for the scan…')}
                </p>
              </div>
            ) : status === 'qr' || status === 'connecting' ? (
              <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin text-primary" />
                {status === 'connecting' ? t('Reconnecting to WhatsApp…') : t('Generating QR code…')}
              </div>
            ) : (
              <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3">
                <QrCode className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                <div className="text-sm text-muted-foreground">
                  {t('No number connected. Click Connect to get a QR code.')}
                  {session?.last_error && (
                    <p data-no-translate className="mt-1 text-xs text-red-300">
                      {t('Last error')}: {session.last_error}
                    </p>
                  )}
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              {status === 'connected' ? (
                <Button
                  variant="outline"
                  onClick={handleDisconnect}
                  disabled={disconnecting || disabled || !canManage}
                  className="border-red-900 text-red-400 hover:bg-red-950/40 hover:text-red-300"
                >
                  {disconnecting ? <Loader2 className="size-4 animate-spin" /> : <LogOut className="size-4" />}
                  {t('Disconnect')}
                </Button>
              ) : (
                <Button
                  onClick={handleConnect}
                  disabled={connecting || loading || disabled || !canManage || status === 'qr'}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {connecting ? <Loader2 className="size-4 animate-spin" /> : <QrCode className="size-4" />}
                  {status === 'connecting' ? t('Retry') : t('Connect')}
                </Button>
              )}
              {status !== 'disconnected' && status !== 'connected' && (
                <Button
                  variant="outline"
                  onClick={handleDisconnect}
                  disabled={disconnecting || disabled || !canManage}
                  className="border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {t('Cancel')}
                </Button>
              )}
              {!canManage && (
                <p className="self-center text-xs text-muted-foreground">
                  {t('Only account admins can connect or disconnect the number.')}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <div>
        <Card>
          <CardHeader>
            <CardTitle className="text-base text-foreground">{t('How it works')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('What the QR channel can and cannot do.')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>{t('Receives and sends 1:1 messages (text, images, audio, video, documents).')}</li>
              <li>{t('Reply automations work; buttons and lists are sent as numbered text.')}</li>
              <li>{t('Broadcasts and message templates stay on the official API.')}</li>
              <li>{t('Keep the phone online — WhatsApp Web depends on it.')}</li>
              <li>{t('Counts as one channel against your plan limit while connected.')}</li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
