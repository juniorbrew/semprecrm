'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { AlertTriangle, Loader2 } from 'lucide-react';

import { useAuth, useEntitlements } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import { Button, buttonVariants } from '@/components/ui/button';
import { ContactAvatar } from '@/components/inbox/contact-avatar';
import { MESSAGING_LABEL, messagingModule } from '@/lib/meta-messaging/channels';
import { cn } from '@/lib/utils';
import type { MetaMessagingChannel } from '@/types';

import { SettingsChip } from './settings-chip';
import { SettingsGroup } from './settings-group';

interface Connection {
  name: string | null;
  picture_url: string | null;
  status: 'active' | 'expired' | 'error' | 'revoked';
}
type StatusMap = Record<MetaMessagingChannel, { configured: boolean; connection: Connection | null }>;
interface PageOption {
  id: string;
  name: string | null;
  picture_url: string | null;
}

const KINDS: MetaMessagingChannel[] = ['instagram', 'messenger'];

/** `?meta_error=` codes sent back by the connect routes (src/lib/meta-messaging/connect/handlers.ts). */
const ERRORS: Record<string, string> = {
  not_configured: 'This channel is not set up by the platform yet.',
  module: 'Your plan does not include this channel.',
  forbidden: 'Only account admins can connect channels.',
  unauthorized: 'Your session expired. Sign in again.',
  denied: 'The connection was cancelled.',
  state: 'The connection expired or was not started here. Try again.',
  exchange: 'Meta did not accept the connection. Try again.',
  provider: 'Meta returned an error. Try again.',
  no_pages: 'No Facebook Page found. Create or get access to a Page and try again.',
  owned: 'This account is already connected to another SempreCRM account.',
  subscribe: 'Could not turn on message delivery at Meta. Try again.',
  save: 'Could not save the connection. Try again.',
};

/**
 * Settings → WhatsApp → "Instagram e Messenger": one card per channel. The OAuth round trip is a
 * plain navigation to /api/meta/messaging/connect/<kind>; the result comes back as
 * `?meta=connected|pick` or `?meta_error=<code>` on this page.
 */
export function MetaMessagingPanel() {
  const { t } = useLanguage();
  const ent = useEntitlements();
  const { canEditSettings } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [status, setStatus] = useState<StatusMap | null>(null);
  const [busy, setBusy] = useState<MetaMessagingChannel | null>(null);
  const [pickSession, setPickSession] = useState<string | null>(null);
  const [pages, setPages] = useState<PageOption[] | null>(null);
  const [picking, setPicking] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/meta/messaging/status', { cache: 'no-store' });
      if (res.ok) setStatus((await res.json()) as StatusMap);
    } catch {
      /* the cards just stay in their loading state */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Result of the OAuth round trip, then clean the query so a refresh does not repeat it.
  useEffect(() => {
    const meta = searchParams.get('meta');
    const error = searchParams.get('meta_error');
    if (!meta && !error) return;
    if (meta === 'connected') toast.success(t('Channel connected'));
    else if (meta === 'pick') setPickSession(searchParams.get('session'));
    else if (error) toast.error(t(ERRORS[error] ?? ERRORS.provider));
    const params = new URLSearchParams(searchParams.toString());
    for (const k of ['meta', 'meta_error', 'kind', 'session']) params.delete(k);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    void load();
  }, [searchParams, router, pathname, t, load]);

  useEffect(() => {
    if (!pickSession) return;
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/meta/messaging/pages?session=${encodeURIComponent(pickSession)}`, { cache: 'no-store' });
      if (cancelled) return;
      if (res.ok) setPages(((await res.json()) as { pages: PageOption[] }).pages);
      else {
        toast.error(t('The choice expired. Connect again.'));
        setPickSession(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pickSession, t]);

  async function disconnect(kind: MetaMessagingChannel) {
    setBusy(kind);
    try {
      const res = await fetch('/api/meta/messaging/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }),
      });
      if (!res.ok) throw new Error('disconnect failed');
      toast.success(t('Channel disconnected'));
      await load();
    } catch {
      toast.error(t('Could not disconnect'));
    } finally {
      setBusy(null);
    }
  }

  async function pickPage(pageId: string) {
    if (!pickSession) return;
    setPicking(true);
    try {
      const res = await fetch('/api/meta/messaging/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: pickSession, page_id: pageId }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'failed');
      toast.success(t('Channel connected'));
      setPickSession(null);
      setPages(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error && err.message !== 'failed' ? err.message : t(ERRORS.save));
    } finally {
      setPicking(false);
    }
  }

  if (!ent.ready) return null;

  return (
    <SettingsGroup
      className="mt-10 max-w-2xl"
      title={t('Instagram and Messenger')}
      description={t('Answer Instagram Direct and Facebook Messenger messages in the same inbox, with the same team.')}
    >
      <ul className="divide-y divide-border">
        {KINDS.map((kind) => {
          const label = MESSAGING_LABEL[kind];
          const info = status?.[kind];
          const conn = info?.connection && info.connection.status !== 'revoked' ? info.connection : null;
          const moduleOn = ent.modules[messagingModule(kind)];
          const needsReconnect = conn && conn.status !== 'active';
          const connectHref = `/api/meta/messaging/connect/${kind}`;
          return (
            <li key={kind} className="flex flex-wrap items-center gap-3 py-4" data-testid={`meta-card-${kind}`}>
              <ContactAvatar src={conn?.picture_url} name={conn?.name || label} className="h-10 w-10 text-sm" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">
                  {kind === 'messenger' ? t('Facebook Messenger') : label}
                </p>
                <p className="truncate text-sm text-muted-foreground" data-no-translate>
                  {conn ? conn.name : ''}
                </p>
                {!moduleOn ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('Your plan does not include this channel. Get in touch with the SempreCRM team to add it.')}
                  </p>
                ) : info && !info.configured ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">{t('Not set up by the platform yet')}</p>
                ) : null}
              </div>

              {conn && !needsReconnect && <SettingsChip variant="ok">{t('Connected')}</SettingsChip>}
              {needsReconnect && (
                <span className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="size-3.5" aria-hidden />
                  {t('Needs reconnection')}
                </span>
              )}

              {!status ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label={t('Loading')} />
              ) : moduleOn && canEditSettings ? (
                <div className="flex items-center gap-2">
                  {(!conn || needsReconnect) && info?.configured && (
                    <a href={connectHref} className={cn(buttonVariants({ size: 'sm', variant: needsReconnect ? 'default' : 'outline' }))}>
                      {needsReconnect ? t('Reconnect') : t('Connect')}
                    </a>
                  )}
                  {conn && (
                    <Button size="sm" variant="ghost" disabled={busy === kind} onClick={() => void disconnect(kind)}>
                      {busy === kind ? <Loader2 className="size-4 animate-spin" /> : t('Disconnect')}
                    </Button>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {pickSession && (
        <div role="dialog" aria-label={t('Choose a Facebook Page')} className="space-y-3 rounded-lg border border-border p-4">
          <p className="text-sm font-medium text-foreground">{t('Choose the Facebook Page to connect')}</p>
          {!pages ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : (
            <ul className="space-y-1">
              {pages.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    disabled={picking}
                    onClick={() => void pickPage(p.id)}
                    className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-muted disabled:opacity-60"
                  >
                    <ContactAvatar src={p.picture_url} name={p.name || '?'} className="h-8 w-8 text-xs" />
                    <span className="min-w-0 flex-1 truncate" data-no-translate>
                      {p.name || p.id}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Button size="sm" variant="ghost" onClick={() => { setPickSession(null); setPages(null); }}>
            {t('Cancel')}
          </Button>
        </div>
      )}
    </SettingsGroup>
  );
}
