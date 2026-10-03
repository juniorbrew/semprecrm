'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Loader2, LogOut, QrCode, RefreshCw, Unplug } from 'lucide-react';

import { useLanguage } from '@/hooks/use-language';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import type { Language } from '@/lib/i18n';
import { StatusDot } from './settings-chip';
import { DANGER_TEXT_BUTTON, SettingsDangerZone, SettingsGroup } from './settings-group';
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

const STATUS_TONE: Record<WaQrSessionStatus, 'ok' | 'warn' | 'bad' | 'muted'> = {
  disconnected: 'muted',
  qr: 'warn',
  connecting: 'warn',
  connected: 'ok',
};

const COPY: Record<Language, { danger: string }> = {
  'pt-BR': { danger: 'Zona de risco' },
  'en-US': { danger: 'Danger zone' },
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
        // The API's message carries transport detail ("(fetch failed)")
        // and env names — the panel renders its own user-facing copy.
        setProblemMessage('');
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
  const copy = COPY[language] ?? COPY['pt-BR'];

  return (
    <div className="space-y-8">
      {/* Risk notice — always visible, it is the point of this screen. */}
      <div role="note" className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{t('Unofficial channel — use with care')}</p>
          <p className="mt-1 max-w-[62ch] text-sm leading-relaxed text-muted-foreground">
            {t(
              'The WhatsApp Web protocol is reverse-engineered (Baileys library). It is not official, it violates WhatsApp’s terms and the number can be banned, especially with bulk sending. Broadcasts and templates therefore stay exclusive to the official API; the QR channel is for 1:1 support and reply automations.',
            )}
          </p>
        </div>
      </div>

      {/* Gateway problems — the panel degrades instead of crashing. */}
      {problem === 'gateway_unconfigured' && (
        <div role="status" className="flex items-start gap-2.5">
          <Unplug className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium text-foreground">{t('QR connection not available')}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('The QR code connection has not been set up by the server administrator yet.')}
            </p>
          </div>
        </div>
      )}
      {problem === 'gateway_unreachable' && (
        <div role="alert" className="flex items-start gap-2.5">
          <StatusDot tone="bad" className="mt-2" />
          <div className="flex-1">
            <p className="text-sm font-medium text-foreground">{t('Could not connect')}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {problemMessage ||
                t('Could not connect to the WhatsApp service. Try again in a moment; if it keeps failing, contact the server administrator.')}
            </p>
            <Button size="sm" variant="outline" className="mt-3" onClick={() => void fetchStatus()}>
              <RefreshCw className="size-3.5" />
              {t('Try again')}
            </Button>
          </div>
        </div>
      )}
      {problem === 'module_not_included' && (
        <div role="status">
          <p className="text-sm font-medium text-foreground">{t('Module not included in your plan')}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('The QR channel is not part of your current plan. Get in touch with the SempreCRM team to add it.')}
          </p>
        </div>
      )}

      <SettingsGroup
        title={t('WhatsApp Web session')}
        description={t('Scan the QR code with the phone that owns the number: WhatsApp → Linked devices → Link a device.')}
        action={
          <span className="inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap text-foreground">
            <StatusDot tone={STATUS_TONE[status]} />
            {statusLabel[status]}
          </span>
        }
      >
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : status === 'connected' ? (
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm text-foreground">
              <StatusDot tone="ok" />
              {t('Connected as')}{' '}
              <span data-no-translate className="font-medium">
                {name || t('Unknown name')} · {phone || t('unknown number')}
              </span>
            </p>
            {session?.connected_at && (
              <p data-no-translate className="mt-0.5 pl-3.5 text-xs text-muted-foreground tabular-nums">
                {t('Since')} {new Date(session.connected_at).toLocaleString(language)}
              </p>
            )}
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
            <Loader2 className="size-4 animate-spin" />
            {status === 'connecting' ? t('Reconnecting to WhatsApp…') : t('Generating QR code…')}
          </div>
        ) : (
          <div className="flex items-start gap-2.5">
            <QrCode className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="text-sm text-muted-foreground">
              {t('No number connected. Click Connect to get a QR code.')}
              {session?.last_error && (
                <p data-no-translate className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <StatusDot tone="bad" />
                  {t('Last error')}: {session.last_error}
                </p>
              )}
            </div>
          </div>
        )}

        {status !== 'connected' || !canManage ? (
          <div className="flex flex-wrap items-center gap-3">
            {status !== 'connected' && (
              <Button
                onClick={handleConnect}
                disabled={connecting || loading || disabled || !canManage || status === 'qr'}
              >
                {connecting ? <Loader2 className="size-4 animate-spin" /> : <QrCode className="size-4" />}
                {status === 'connecting' ? t('Retry') : t('Connect')}
              </Button>
            )}
            {status !== 'disconnected' && status !== 'connected' && (
              <Button
                variant="ghost"
                onClick={handleDisconnect}
                disabled={disconnecting || disabled || !canManage}
              >
                {t('Cancel')}
              </Button>
            )}
            {!canManage && (
              <p className="text-xs text-muted-foreground">
                {t('Only account admins can connect or disconnect the number.')}
              </p>
            )}
          </div>
        ) : null}
      </SettingsGroup>

      <SettingsGroup
        title={t('How it works')}
        description={t('What the QR channel can and cannot do.')}
      >
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground marker:text-border">
          <li>{t('Receives and sends 1:1 messages (text, images, audio, video, documents).')}</li>
          <li>{t('Reply automations work; buttons and lists are sent as numbered text.')}</li>
          <li>{t('Broadcasts and message templates stay on the official API.')}</li>
          <li>{t('Keep the phone online — WhatsApp Web depends on it.')}</li>
          <li>{t('Counts as one channel against your plan limit while connected.')}</li>
        </ul>
      </SettingsGroup>

      {status === 'connected' && canManage && (
        <SettingsDangerZone title={copy.danger} className="mt-0">
          <Button
            variant="ghost"
            size="sm"
            className={DANGER_TEXT_BUTTON}
            onClick={handleDisconnect}
            disabled={disconnecting || disabled}
          >
            {disconnecting ? <Loader2 className="size-3.5 animate-spin" /> : <LogOut className="size-3.5" />}
            {t('Disconnect')}
          </Button>
        </SettingsDangerZone>
      )}
    </div>
  );
}
