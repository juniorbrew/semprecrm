'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Webhook,
} from 'lucide-react';
import { toast } from 'sonner';

import { useLanguage } from '@/hooks/use-language';
import { formatRelative } from '@/lib/automations/trigger-meta';
import { ALL_EVENTS, WEBHOOK_EVENTS, WEBHOOK_EVENT_DESCRIPTIONS } from '@/lib/webhooks/events';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

import { apiJson, useCopy } from './api-webhooks-shared';
import { DANGER_TEXT_BUTTON, SETTINGS_HEADING, SettingsGroup } from './settings-group';
import { SettingsChip } from './settings-chip';

interface Endpoint {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  enabled: boolean;
  disabled_reason: string | null;
  failing_since: string | null;
  previous_secret_expires_at: string | null;
}

interface Delivery {
  id: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  next_attempt_at: string;
  last_status_code: number | null;
  last_error: string | null;
  last_attempt_at: string | null;
  created_at: string;
  event_type: string | null;
  event_public_id: string;
  resend_of: string | null;
}

interface Attempt {
  attempt_no: number;
  started_at: string;
  duration_ms: number | null;
  status_code: number | null;
  error: string | null;
  response_snippet: string | null;
}

interface EditState {
  id: string | null;
  url: string;
  description: string;
  events: string[];
}

const EMPTY_EDIT: EditState = { id: null, url: '', description: '', events: [ALL_EVENTS] };

/** Configurações → API e Webhooks: outbound webhook endpoints with delivery log. */
export function WebhookEndpointsGroup() {
  const { t } = useLanguage();
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [busy, setBusy] = useState(false);
  const [secretShown, setSecretShown] = useState<{ title: string; secret: string } | null>(null);
  const [toDelete, setToDelete] = useState<Endpoint | null>(null);
  const { copied, copy } = useCopy();

  const load = useCallback(async () => {
    try {
      const res = await apiJson<{ endpoints: Endpoint[] }>('/api/webhooks/endpoints');
      setEndpoints(res.endpoints);
    } catch (err) {
      toast.error(t(err instanceof Error ? err.message : 'Failed to load webhook endpoints'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!edit) return;
    setBusy(true);
    try {
      const body = JSON.stringify({ url: edit.url, description: edit.description, events: edit.events });
      if (edit.id) {
        await apiJson(`/api/webhooks/endpoints/${edit.id}`, { method: 'PATCH', body });
        toast.success(t('Endpoint updated'));
      } else {
        const res = await apiJson<{ endpoint: Endpoint; secret: string }>('/api/webhooks/endpoints', {
          method: 'POST',
          body,
        });
        setSelected(res.endpoint.id);
        setSecretShown({ title: t('Endpoint created'), secret: res.secret });
      }
      setEdit(null);
      await load();
    } catch (err) {
      toast.error(t(err instanceof Error ? err.message : 'Failed to save the endpoint'));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(ep: Endpoint, enabled: boolean) {
    try {
      await apiJson(`/api/webhooks/endpoints/${ep.id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
      await load();
    } catch (err) {
      toast.error(t(err instanceof Error ? err.message : 'Failed to update the endpoint'));
    }
  }

  async function remove() {
    if (!toDelete) return;
    setBusy(true);
    try {
      await apiJson(`/api/webhooks/endpoints/${toDelete.id}`, { method: 'DELETE' });
      setToDelete(null);
      setSelected(null);
      toast.success(t('Endpoint deleted'));
      await load();
    } catch (err) {
      toast.error(t(err instanceof Error ? err.message : 'Failed to delete the endpoint'));
    } finally {
      setBusy(false);
    }
  }

  const allEvents = edit?.events.includes(ALL_EVENTS) ?? false;

  return (
    <SettingsGroup
      title={t('Webhook endpoints')}
      description={t(
        'SempreCRM sends a signed POST to your URL whenever the events you pick happen. Failed deliveries are retried for up to 3 days.',
      )}
      action={
        <Button size="sm" onClick={() => setEdit(EMPTY_EDIT)}>
          <Plus className="size-4" />
          {t('Add endpoint')}
        </Button>
      }
    >
      {loading ? (
        <div className="h-12 animate-pulse rounded-lg bg-muted/60" />
      ) : endpoints.length === 0 ? (
        <div className="py-6 text-center">
          <Webhook className="mx-auto size-5 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium text-foreground">{t('No webhook endpoints yet')}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('Add an https URL to receive messages, conversations and contacts in real time.')}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border border-y border-border">
          {endpoints.map((ep) => {
            const open = selected === ep.id;
            return (
              <li key={ep.id}>
                <div className="flex items-center gap-3 py-2.5">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    aria-expanded={open}
                    onClick={() => setSelected(open ? null : ep.id)}
                  >
                    {open ? (
                      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-xs text-foreground">{ep.url}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {ep.description ? `${ep.description} · ` : ''}
                        {ep.events.includes(ALL_EVENTS) ? t('All events') : ep.events.join(', ')}
                      </span>
                    </span>
                  </button>
                  {ep.disabled_reason === 'auto_failures' ? (
                    <SettingsChip variant="bad">{t('Disabled after repeated failures')}</SettingsChip>
                  ) : ep.failing_since && ep.enabled ? (
                    <SettingsChip variant="warn">{t('Failing')}</SettingsChip>
                  ) : null}
                  <Switch
                    checked={ep.enabled}
                    onCheckedChange={(v) => void toggle(ep, v)}
                    aria-label={t('Enabled')}
                  />
                </div>
                {open ? (
                  <EndpointDetail
                    endpoint={ep}
                    onEdit={() =>
                      setEdit({ id: ep.id, url: ep.url, description: ep.description ?? '', events: ep.events })
                    }
                    onDelete={() => setToDelete(ep)}
                    onSecret={(title, secret) => setSecretShown({ title, secret })}
                    onChanged={load}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {/* create / edit */}
      <Dialog open={!!edit} onOpenChange={(o) => !busy && !o && setEdit(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{edit?.id ? t('Edit endpoint') : t('Add endpoint')}</DialogTitle>
            <DialogDescription>
              {t('The URL must use https and be reachable from the internet.')}
            </DialogDescription>
          </DialogHeader>
          {edit ? (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="wh-url">{t('Endpoint URL')}</Label>
                <Input
                  id="wh-url"
                  inputMode="url"
                  value={edit.url}
                  onChange={(e) => setEdit({ ...edit, url: e.target.value })}
                  placeholder="https://n8n.example.com/webhook/semprecrm"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wh-desc">{t('Description')}</Label>
                <Input
                  id="wh-desc"
                  value={edit.description}
                  maxLength={200}
                  onChange={(e) => setEdit({ ...edit, description: e.target.value })}
                />
              </div>
              <fieldset className="space-y-2">
                <legend className="mb-1 text-sm font-medium text-foreground">{t('Events to send')}</legend>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={allEvents}
                    onCheckedChange={(v) => setEdit({ ...edit, events: v === true ? [ALL_EVENTS] : [] })}
                  />
                  {t('All events')}
                </label>
                {WEBHOOK_EVENTS.map((ev) => (
                  <label key={ev} className="flex items-start gap-2 text-sm">
                    <Checkbox
                      checked={allEvents || edit.events.includes(ev)}
                      disabled={allEvents}
                      onCheckedChange={(v) =>
                        setEdit({
                          ...edit,
                          events: v === true ? [...edit.events, ev] : edit.events.filter((x) => x !== ev),
                        })
                      }
                      className="mt-0.5"
                    />
                    <span>
                      <span className="font-mono text-xs">{ev}</span>
                      <span className="block text-xs text-muted-foreground">
                        {t(WEBHOOK_EVENT_DESCRIPTIONS[ev])}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEdit(null)} disabled={busy}>
              {t('Cancel')}
            </Button>
            <Button onClick={save} disabled={busy || !edit || !edit.url.trim() || edit.events.length === 0}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('Save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* secret */}
      <Dialog open={!!secretShown} onOpenChange={(o) => !o && setSecretShown(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{secretShown?.title}</DialogTitle>
            <DialogDescription>
              {t('Use this signing secret to verify that requests really come from SempreCRM. You can reveal it again later.')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs">
              {secretShown?.secret}
            </code>
            <Button
              variant="outline"
              size="icon"
              aria-label={t('Copy')}
              onClick={() => secretShown && copy('secret', secretShown.secret)}
            >
              {copied === 'secret' ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setSecretShown(null)}>{t('Done')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* delete */}
      <Dialog open={!!toDelete} onOpenChange={(o) => !busy && !o && setToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Delete endpoint')}</DialogTitle>
            <DialogDescription>
              {t('Pending deliveries and the delivery log of this endpoint are deleted too.')}
            </DialogDescription>
          </DialogHeader>
          <p className="break-all font-mono text-xs text-foreground">{toDelete?.url}</p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setToDelete(null)} disabled={busy}>
              {t('Cancel')}
            </Button>
            <Button variant="destructive" onClick={remove} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('Delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  );
}

function EndpointDetail({
  endpoint,
  onEdit,
  onDelete,
  onSecret,
  onChanged,
}: {
  endpoint: Endpoint;
  onEdit: () => void;
  onDelete: () => void;
  onSecret: (title: string, secret: string) => void;
  onChanged: () => Promise<void>;
}) {
  const { t, language } = useLanguage();
  const [secret, setSecret] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [filter, setFilter] = useState<'all' | 'delivered' | 'pending' | 'failed'>('all');
  const [logLoading, setLogLoading] = useState(true);
  const [opened, setOpened] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ payload: unknown; attempts: Attempt[] } | null>(null);

  const loadLog = useCallback(
    async (before?: string) => {
      try {
        const q = new URLSearchParams();
        if (filter !== 'all') q.set('status', filter);
        if (before) q.set('before', before);
        const res = await apiJson<{ deliveries: Delivery[]; has_more: boolean }>(
          `/api/webhooks/endpoints/${endpoint.id}/deliveries?${q}`,
        );
        setDeliveries((cur) => (before ? [...cur, ...res.deliveries] : res.deliveries));
        setHasMore(res.has_more);
      } catch (err) {
        toast.error(t(err instanceof Error ? err.message : 'Failed to load deliveries'));
      } finally {
        setLogLoading(false);
      }
    },
    [endpoint.id, filter, t],
  );

  useEffect(() => {
    setLogLoading(true);
    void loadLog();
  }, [loadLog]);

  async function run<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
    setWorking(key);
    try {
      return await fn();
    } catch (err) {
      toast.error(t(err instanceof Error ? err.message : 'Something went wrong'));
    } finally {
      setWorking(null);
    }
  }

  async function toggleSecret() {
    if (secret) return setSecret(null);
    const res = await run('reveal', () => apiJson<{ secret: string }>(`/api/webhooks/endpoints/${endpoint.id}/secret`));
    if (res) setSecret(res.secret);
  }

  async function rotate() {
    const res = await run('rotate', () =>
      apiJson<{ secret: string }>(`/api/webhooks/endpoints/${endpoint.id}/secret`, {
        method: 'POST',
        body: JSON.stringify({ overlap_hours: 24 }),
      }),
    );
    if (res) {
      setSecret(null);
      onSecret(t('New signing secret'), res.secret);
      await onChanged();
    }
  }

  async function sendTest() {
    const res = await run('test', () =>
      apiJson<{ delivery: Delivery }>(`/api/webhooks/endpoints/${endpoint.id}/test`, { method: 'POST' }),
    );
    if (!res) return;
    if (res.delivery.status === 'delivered') toast.success(`${t('Test event delivered')} (HTTP ${res.delivery.last_status_code})`);
    else toast.error(`${t('Test event failed')}: ${res.delivery.last_error ?? ''}`);
    await loadLog();
  }

  async function resend(d: Delivery) {
    const res = await run(`resend-${d.id}`, () =>
      apiJson<{ delivery: Delivery }>(`/api/webhooks/deliveries/${d.id}`, { method: 'POST' }),
    );
    if (!res) return;
    if (res.delivery.status === 'delivered') toast.success(t('Event resent'));
    else toast.error(`${t('Resend failed')}: ${res.delivery.last_error ?? ''}`);
    await loadLog();
  }

  async function toggleDetail(d: Delivery) {
    if (opened === d.id) return setOpened(null);
    setOpened(d.id);
    setDetail(null);
    const res = await run(`detail-${d.id}`, () =>
      apiJson<{ payload: unknown; attempts: Attempt[] }>(`/api/webhooks/deliveries/${d.id}`),
    );
    if (res) setDetail(res);
  }

  const statusChip = (d: Delivery) =>
    d.status === 'delivered' ? (
      <SettingsChip variant="ok">{t('Delivered')}</SettingsChip>
    ) : d.status === 'pending' ? (
      <SettingsChip variant="warn">{t('Pending')}</SettingsChip>
    ) : (
      <SettingsChip variant="bad">{t('Failed')}</SettingsChip>
    );

  return (
    <div className="space-y-5 pb-5 pl-6">
      {endpoint.disabled_reason === 'auto_failures' ? (
        <p role="alert" className="text-sm text-destructive">
          {t('This endpoint was disabled automatically after 2 days without a successful delivery. Fix the URL and turn it back on; pending events keep being retried for up to 3 days.')}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={sendTest} disabled={working === 'test'}>
          {working === 'test' ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
          {t('Send test event')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <Pencil className="size-3.5" />
          {t('Edit')}
        </Button>
        <Button variant="ghost" size="sm" className={DANGER_TEXT_BUTTON} onClick={onDelete}>
          <Trash2 className="size-3.5" />
          {t('Delete')}
        </Button>
      </div>

      <div className="space-y-1.5">
        <h4 className={SETTINGS_HEADING}>{t('Signing secret')}</h4>
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded-md border border-border bg-muted px-2.5 py-1.5 font-mono text-xs break-all">
            {secret ?? 'whsec_••••••••••••••••'}
          </code>
          <Button variant="ghost" size="sm" onClick={toggleSecret} disabled={working === 'reveal'}>
            {secret ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            {secret ? t('Hide') : t('Reveal')}
          </Button>
          <Button variant="ghost" size="sm" onClick={rotate} disabled={working === 'rotate'}>
            <RefreshCw className="size-3.5" />
            {t('Rotate secret')}
          </Button>
        </div>
        {endpoint.previous_secret_expires_at && new Date(endpoint.previous_secret_expires_at) > new Date() ? (
          <p className="text-xs text-muted-foreground">
            {t('The previous secret also signs deliveries until')}{' '}
            {new Date(endpoint.previous_secret_expires_at).toLocaleString(language)}.
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h4 className={SETTINGS_HEADING}>{t('Delivery log')}</h4>
          <div role="group" aria-label={t('Filter')} className="flex gap-1">
            {(['all', 'delivered', 'pending', 'failed'] as const).map((f) => (
              <Button
                key={f}
                variant={filter === f ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {f === 'all' ? t('All') : f === 'delivered' ? t('Delivered') : f === 'pending' ? t('Pending') : t('Failed')}
              </Button>
            ))}
          </div>
        </div>
        {logLoading ? (
          <div className="h-10 animate-pulse rounded-lg bg-muted/60" />
        ) : deliveries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('No deliveries yet. Send a test event to try it.')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 font-normal">{t('Event')}</th>
                  <th className="px-2 py-1.5 font-normal">{t('Status')}</th>
                  <th className="px-2 py-1.5 font-normal">HTTP</th>
                  <th className="px-2 py-1.5 font-normal">{t('Attempts')}</th>
                  <th className="px-2 py-1.5 font-normal">{t('When')}</th>
                  <th className="w-px px-2 py-1.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border border-t border-border">
                {deliveries.map((d) => (
                  <DeliveryRows
                    key={d.id}
                    d={d}
                    open={opened === d.id}
                    detail={opened === d.id ? detail : null}
                    chip={statusChip(d)}
                    onToggle={() => void toggleDetail(d)}
                    onResend={() => void resend(d)}
                    resending={working === `resend-${d.id}`}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {hasMore ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void loadLog(deliveries[deliveries.length - 1]?.created_at)}
          >
            {t('Load more')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function DeliveryRows({
  d,
  open,
  detail,
  chip,
  onToggle,
  onResend,
  resending,
}: {
  d: Delivery;
  open: boolean;
  detail: { payload: unknown; attempts: Attempt[] } | null;
  chip: React.ReactNode;
  onToggle: () => void;
  onResend: () => void;
  resending: boolean;
}) {
  const { t, language } = useLanguage();
  return (
    <>
      <tr className={cn('align-middle', open && 'bg-muted/40')}>
        <td className="px-2 py-2">
          <button type="button" onClick={onToggle} aria-expanded={open} className="text-left">
            <span className="block font-mono text-xs text-foreground">{d.event_type}</span>
            <span className="block font-mono text-[10.5px] text-muted-foreground">{d.event_public_id}</span>
          </button>
        </td>
        <td className="px-2 py-2">
          {chip}
          {d.status === 'pending' && d.attempts > 0 ? (
            <span className="block text-[11px] text-muted-foreground">
              {t('Next attempt')} {new Date(d.next_attempt_at).toLocaleString(language)}
            </span>
          ) : null}
        </td>
        <td className="px-2 py-2 font-mono text-xs">{d.last_status_code ?? '—'}</td>
        <td className="px-2 py-2 text-xs">{d.attempts}</td>
        <td className="px-2 py-2 text-xs text-muted-foreground">{formatRelative(d.created_at, language)}</td>
        <td className="px-2 py-2 text-right">
          <Button variant="ghost" size="sm" onClick={onResend} disabled={resending}>
            {resending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            {t('Resend')}
          </Button>
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={6} className="bg-muted/30 px-3 py-3">
            {!detail ? (
              <div className="h-8 animate-pulse rounded bg-muted/60" />
            ) : (
              <div className="space-y-3">
                <ul className="space-y-1 text-xs">
                  {detail.attempts.map((a) => (
                    <li key={a.attempt_no} className="flex flex-wrap gap-x-3">
                      <span className="font-medium">#{a.attempt_no}</span>
                      <span>{new Date(a.started_at).toLocaleString(language)}</span>
                      <span className="font-mono">{a.status_code ?? '—'}</span>
                      {a.duration_ms != null ? <span>{a.duration_ms} ms</span> : null}
                      {a.error ? <span className="text-destructive">{a.error}</span> : null}
                      {a.response_snippet ? (
                        <span className="w-full truncate font-mono text-muted-foreground">{a.response_snippet}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <pre className="max-h-64 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-[11px]">
                  {JSON.stringify(detail.payload, null, 2)}
                </pre>
              </div>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}
