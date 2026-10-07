'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useLanguage } from '@/hooks/use-language';
import {
  auditActionLabel,
  auditActorLabel,
  AUDIT_ROLE_LABELS,
} from '@/lib/audit';
import type {
  ActivityPage,
  ActivitySection,
  PlatformMember,
  PlatformInvitation,
  PlatformChannel,
  PlatformHistory,
} from '@/lib/platform/activity-types';

type ActivityItem = { id: string } | { user_id: string };

function useActivitySection<T extends ActivityItem>(
  accountId: string,
  section: ActivitySection,
  enabled: boolean
) {
  const [items, setItems] = useState<T[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const attempted = useRef(false);
  const busy = useRef(false);
  const lastCursor = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(
    async (cursor: string | null) => {
      if (busy.current) return;
      busy.current = true;
      attempted.current = true;
      lastCursor.current = cursor;
      const request = new AbortController();
      controller.current = request;
      setLoading(true);
      setError(false);
      try {
        const query = new URLSearchParams({ section });
        if (cursor) query.set('cursor', cursor);
        const response = await fetch(
          `/api/platform/accounts/${encodeURIComponent(accountId)}/activity?${query}`,
          { signal: request.signal, cache: 'no-store' }
        );
        if (!response.ok) throw new Error('Activity request failed');
        const page = (await response.json()) as ActivityPage<T>;
        if (!Array.isArray(page.items))
          throw new Error('Invalid activity response');
        if (request.signal.aborted) return;
        setItems((previous) => {
          const merged = new Map<string, T>();
          for (const item of [...(cursor ? previous : []), ...page.items]) {
            merged.set('user_id' in item ? item.user_id : item.id, item);
          }
          return [...merged.values()];
        });
        setNextCursor(page.nextCursor);
        setLoaded(true);
      } catch {
        if (!request.signal.aborted) setError(true);
      } finally {
        if (controller.current === request) busy.current = false;
        if (!request.signal.aborted) setLoading(false);
      }
    },
    [accountId, section]
  );

  useEffect(() => {
    if (enabled && !attempted.current) void load(null);
  }, [enabled, load]);

  useEffect(
    () => () => {
      controller.current?.abort();
      attempted.current = false;
      busy.current = false;
    },
    []
  );

  return {
    items,
    nextCursor,
    loading,
    loaded,
    error,
    retry: () => void load(lastCursor.current),
    refresh: () => void load(null),
    loadMore: () => {
      if (nextCursor) void load(nextCursor);
    },
  };
}

type SectionState<T extends ActivityItem> = ReturnType<
  typeof useActivitySection<T>
>;

function ActivityList<T extends ActivityItem>({
  state,
  empty,
  children,
}: {
  state: SectionState<T>;
  empty: string;
  children: ReactNode;
}) {
  const { t } = useLanguage();
  return (
    <div aria-busy={state.loading}>
      {state.loaded && (
        <p className="text-muted-foreground mb-3 text-xs" role="status">
          {state.items.length} {t('records loaded')}
        </p>
      )}
      {state.loading && !state.loaded ? (
        <div role="status" className="space-y-3 py-3">
          <span className="sr-only">{t('Loading company activity')}</span>
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              aria-hidden="true"
              className="bg-muted h-12 rounded-md motion-safe:animate-pulse"
            />
          ))}
        </div>
      ) : state.loaded && !state.items.length ? (
        <p className="text-muted-foreground py-5 text-sm">{t(empty)}</p>
      ) : (
        children
      )}
      {state.error && (
        <div
          role="alert"
          className="mt-3 flex flex-wrap items-center gap-3 text-sm"
        >
          <p>{t('Could not load this list. Try again.')}</p>
          <Button
            type="button"
            variant="outline"
            onClick={state.retry}
            disabled={state.loading}
          >
            {t('Try again')}
          </Button>
        </div>
      )}
      {state.loading && state.loaded && (
        <p role="status" className="text-muted-foreground mt-3 text-sm">
          {t('Loading company activity')}
        </p>
      )}
      {!state.error && state.nextCursor && (
        <Button
          type="button"
          variant="outline"
          className="mt-4"
          onClick={state.loadMore}
          disabled={state.loading}
        >
          {t('Load more')}
        </Button>
      )}
    </div>
  );
}

export function PlatformAccountActivity({ accountId }: { accountId: string }) {
  return <AccountActivity key={accountId} accountId={accountId} />;
}

function AccountActivity({ accountId }: { accountId: string }) {
  const { t, language } = useLanguage();
  const [tab, setTab] = useState('members');
  const members = useActivitySection<PlatformMember>(
    accountId,
    'members',
    tab === 'members'
  );
  const invitations = useActivitySection<PlatformInvitation>(
    accountId,
    'invitations',
    tab === 'members'
  );
  const channels = useActivitySection<PlatformChannel>(
    accountId,
    'channels',
    tab === 'channels'
  );
  const history = useActivitySection<PlatformHistory>(
    accountId,
    'history',
    tab === 'history'
  );
  const role = (value: string) =>
    AUDIT_ROLE_LABELS[language][value] ?? t('Not available');
  const date = (value: string | null) => {
    if (!value || Number.isNaN(new Date(value).getTime()))
      return t('Not available');
    return (
      <time dateTime={value}>
        {new Date(value).toLocaleString(language, {
          dateStyle: 'short',
          timeStyle: 'short',
          timeZone: 'America/Bahia',
        })}
      </time>
    );
  };
  const channelStatus = (channel: PlatformChannel) => {
    const labels: Record<string, string> = {
      connected: 'Connected',
      disconnected: 'Disconnected',
      connecting: 'Connecting',
      qr: 'Waiting for QR scan',
    };
    return t(labels[channel.status] ?? 'Not available');
  };

  return (
    <section
      aria-labelledby="company-activity-title"
      className="border-border bg-card min-w-0 rounded-xl border p-5 sm:p-6"
      data-no-translate
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 id="company-activity-title" className="text-lg font-semibold">
          {t('Company activity')}
        </h2>
        <Button
          type="button"
          variant="outline"
          disabled={
            members.loading ||
            invitations.loading ||
            channels.loading ||
            history.loading
          }
          onClick={() => {
            if (tab === 'members') {
              members.refresh();
              invitations.refresh();
            } else if (tab === 'channels') channels.refresh();
            else history.refresh();
          }}
        >
          {t('Refresh list')}
        </Button>
      </div>
      <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
        <TabsList
          aria-label={t('Company activity')}
          className="grid w-full grid-cols-3 group-data-horizontal/tabs:h-auto"
        >
          <TabsTrigger
            value="members"
            className="text-foreground min-h-11 whitespace-normal"
          >
            {t('Users')}
          </TabsTrigger>
          <TabsTrigger
            value="channels"
            className="text-foreground min-h-11 whitespace-normal"
          >
            {t('Channels')}
          </TabsTrigger>
          <TabsTrigger
            value="history"
            className="text-foreground min-h-11 whitespace-normal"
          >
            {t('Change history')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="members" className="mt-4 space-y-6">
          <div>
            <h3 className="mb-3 font-medium">{t('Registered users')}</h3>
            <ActivityList
              state={members}
              empty="No users registered for this company."
            >
              <ul className="divide-border divide-y">
                {members.items.map((member) => (
                  <li
                    key={member.user_id}
                    className="flex flex-col justify-between gap-2 py-3 sm:flex-row sm:items-center"
                  >
                    <div className="min-w-0">
                      <p className="font-medium break-words">
                        {member.full_name || t('Not available')}
                      </p>
                      <p className="text-muted-foreground mt-1 text-xs break-all">
                        {member.email || t('Not available')}
                      </p>
                    </div>
                    <span className="text-muted-foreground text-xs">
                      {role(member.account_role)}
                    </span>
                  </li>
                ))}
              </ul>
            </ActivityList>
          </div>
          <div className="border-border border-t pt-5">
            <h3 className="mb-1 font-medium">{t('Pending invitations')}</h3>
            <p className="text-muted-foreground mb-3 text-xs">
              {t('Pending invitations count toward the user limit.')}
            </p>
            <ActivityList state={invitations} empty="No pending invitations.">
              <ul className="divide-border divide-y">
                {invitations.items.map((invitation) => (
                  <li
                    key={invitation.id}
                    className="flex flex-col justify-between gap-2 py-3 sm:flex-row"
                  >
                    <div className="min-w-0">
                      <p className="font-medium break-words">
                        {invitation.label || t('Invitation without a label')}
                      </p>
                      <p className="text-muted-foreground mt-1 text-xs">
                        {role(invitation.role)}
                      </p>
                    </div>
                    <p className="text-muted-foreground text-xs">
                      {t('Valid until')}: {date(invitation.expires_at)}
                    </p>
                  </li>
                ))}
              </ul>
            </ActivityList>
          </div>
        </TabsContent>
        <TabsContent value="channels" className="mt-4">
          <p className="text-muted-foreground mb-3 text-xs">
            {t(
              'Saved channel data. Connection status is not checked in real time.'
            )}
          </p>
          <ActivityList
            state={channels}
            empty="No channels configured for this company."
          >
            <ul className="divide-border divide-y">
              {channels.items.map((channel) => (
                <li
                  key={`${channel.kind}:${channel.id}`}
                  className="space-y-2 py-4"
                >
                  <div className="flex flex-wrap justify-between gap-2">
                    <p className="max-w-full min-w-0 font-medium break-words">
                      {channel.display_name ||
                        t(
                          channel.kind === 'official'
                            ? 'Official WhatsApp'
                            : 'WhatsApp via QR code'
                        )}
                    </p>
                    <span className="text-muted-foreground text-xs">
                      {channelStatus(channel)}
                    </span>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {t(
                      channel.kind === 'official'
                        ? 'Official WhatsApp'
                        : 'WhatsApp via QR code'
                    )}
                  </p>
                  <p className="text-muted-foreground text-xs break-all">
                    {t(
                      channel.kind === 'official' ? 'Phone number ID' : 'Phone'
                    )}
                    : {channel.identifier || t('Not available')}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {t('Updated at')}: {date(channel.updated_at)}
                  </p>
                </li>
              ))}
            </ul>
          </ActivityList>
        </TabsContent>
        <TabsContent value="history" className="mt-4">
          <ActivityList
            state={history}
            empty="No changes recorded for this company."
          >
            <ol className="divide-border divide-y">
              {history.items.map((event) => (
                <li
                  key={event.id}
                  className="flex flex-col justify-between gap-2 py-3 sm:flex-row"
                >
                  <div className="min-w-0">
                    <p className="font-medium break-words">
                      {auditActionLabel(event.action, language)}
                    </p>
                    <p className="text-muted-foreground mt-1 text-xs break-words">
                      {t('Changed by')}:{' '}
                      {event.actor_name
                        ? auditActorLabel(event.actor_name, language)
                        : t('Not available')}
                    </p>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {date(event.created_at)}
                  </p>
                </li>
              ))}
            </ol>
          </ActivityList>
        </TabsContent>
      </Tabs>
    </section>
  );
}
