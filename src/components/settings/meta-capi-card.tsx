'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw, Send } from 'lucide-react';
import { toast } from 'sonner';

import { useCan } from '@/hooks/use-can';
import { useLanguage } from '@/hooks/use-language';
import { useReadOnly } from '@/hooks/use-read-only';
import { formatRelative } from '@/lib/automations/trigger-meta';
import { formatCurrency } from '@/lib/currency';
import { DATASET_ID_RE, TEST_CODE_RE, TOKEN_RE } from '@/lib/meta-capi/validate';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

import { apiJson } from './api-webhooks-shared';
import { SettingsChip } from './settings-chip';
import { SettingsGroup } from './settings-group';

interface CapiSettings {
  dataset_id: string | null;
  token_last4: string | null;
  test_event_code: string | null;
  send_lead: boolean;
  send_purchase: boolean;
  enabled: boolean;
  paused_reason: string | null;
}

interface CapiEventRow {
  id: string;
  deal_title: string | null;
  event_name: 'lead' | 'purchase';
  status: 'pending' | 'sent' | 'failed' | 'cancelled';
  value: number | string | null;
  currency: string | null;
  last_error: string | null;
  created_at: string;
}

interface Payload {
  settings: CapiSettings | null;
  events: CapiEventRow[];
}

const STATUS_LABEL = {
  sent: 'Sent to Meta',
  pending: 'Waiting to send',
  failed: 'Failed to send',
  cancelled: 'Cancelled event',
} as const;

const STATUS_VARIANT = { sent: 'ok', pending: 'muted', failed: 'bad', cancelled: 'muted' } as const;

/** Configurações → Integrações: tell Meta (Conversions API) which ad leads became leads and sales. */
export function MetaCapiCard() {
  const { t, language } = useLanguage();
  const canEditSettings = useCan('edit-settings');
  const { readOnly } = useReadOnly();
  const canWrite = canEditSettings && !readOnly;

  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [datasetId, setDatasetId] = useState('');
  const [token, setToken] = useState('');
  const [testCode, setTestCode] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  const apply = useCallback((p: Payload) => {
    setData(p);
    setDatasetId(p.settings?.dataset_id ?? '');
    setTestCode(p.settings?.test_event_code ?? '');
    setToken('');
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      apply(await apiJson<Payload>('/api/meta-capi/settings'));
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    if (canEditSettings) void load();
  }, [canEditSettings, load]);

  if (!canEditSettings) return null;

  const s = data?.settings ?? null;
  const hasToken = Boolean(s?.token_last4);

  async function save(patch: Record<string, unknown>, okMessage?: string) {
    setSaving(true);
    try {
      const res = await apiJson<{ settings: CapiSettings }>('/api/meta-capi/settings', {
        method: 'PUT',
        body: JSON.stringify(patch),
      });
      setData((d) => ({ settings: res.settings, events: d?.events ?? [] }));
      if ('token' in patch) setToken('');
      if (okMessage) toast.success(t(okMessage));
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Could not save.'));
      return false;
    } finally {
      setSaving(false);
    }
  }

  const trimmed = { dataset: datasetId.trim(), token: token.trim(), code: testCode.trim() };
  const datasetBad = trimmed.dataset !== '' && !DATASET_ID_RE.test(trimmed.dataset);
  const tokenBad = trimmed.token !== '' && !TOKEN_RE.test(trimmed.token);
  const codeBad = trimmed.code !== '' && !TEST_CODE_RE.test(trimmed.code);
  const dirty =
    trimmed.dataset !== (s?.dataset_id ?? '') || trimmed.token !== '' || trimmed.code !== (s?.test_event_code ?? '');

  async function onSave() {
    const patch: Record<string, unknown> = { dataset_id: trimmed.dataset, test_event_code: trimmed.code };
    if (trimmed.token) patch.token = trimmed.token;
    await save(patch, 'Meta settings saved.');
  }

  async function onTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/meta-capi/test', { method: 'POST', cache: 'no-store' });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
      setTestResult({ ok: Boolean(body.ok), message: body.message ?? body.error ?? 'Something went wrong' });
    } catch {
      setTestResult({ ok: false, message: 'Não foi possível falar com o servidor.' });
    } finally {
      setTesting(false);
    }
  }

  async function onRetry(id: string) {
    setRetrying(id);
    try {
      await apiJson(`/api/meta-capi/events/${id}/retry`, { method: 'POST' });
      toast.success(t('The event is back in the queue.'));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Could not retry.'));
    } finally {
      setRetrying(null);
    }
  }

  return (
    <section className="mt-8 max-w-3xl border-t border-border pt-8" aria-labelledby="meta-capi-title">
      <SettingsGroup
        title={<span id="meta-capi-title">{t('Tell Meta (ads)')}</span>}
        description={t(
          'Tell Meta which customers from your ads became leads and sales, so it can optimise your ads for sales instead of just conversations.',
        )}
      >
        {loading ? (
          <div className="space-y-2" aria-busy="true">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded-lg bg-muted/60" />
            ))}
          </div>
        ) : loadFailed ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-destructive">{t('Could not load the Meta settings.')}</span>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="size-3.5" />
              {t('Try again')}
            </Button>
          </div>
        ) : (
          <div className="space-y-6">
            {s?.paused_reason ? (
              <div role="alert" className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                <p>
                  <span className="font-medium">{t('Sending paused.')}</span>{' '}
                  {t('Meta says the access key is invalid or expired. Paste a new key below to resume.')}
                </p>
              </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="capi-dataset">{t('Dataset ID')}</Label>
                <Input
                  id="capi-dataset"
                  inputMode="numeric"
                  autoComplete="off"
                  value={datasetId}
                  onChange={(e) => setDatasetId(e.target.value)}
                  disabled={!canWrite}
                  aria-invalid={datasetBad}
                  placeholder="1234567890123456"
                />
                {datasetBad ? <p className="text-xs text-destructive">{t('Use numbers only.')}</p> : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="capi-token">{t('Access key')}</Label>
                <Input
                  id="capi-token"
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  disabled={!canWrite}
                  aria-invalid={tokenBad}
                  placeholder={hasToken ? `•••• •••• ${s?.token_last4}` : t('Paste the key from Meta')}
                />
                <p className="text-xs text-muted-foreground">
                  {hasToken ? t('Saved. Paste a new key only to replace it.') : t('Stored encrypted. It never comes back to the browser.')}
                </p>
                {tokenBad ? <p className="text-xs text-destructive">{t('Paste the whole key, without spaces.')}</p> : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="capi-test-code">{t('Test code (optional)')}</Label>
                <Input
                  id="capi-test-code"
                  autoComplete="off"
                  value={testCode}
                  onChange={(e) => setTestCode(e.target.value)}
                  disabled={!canWrite}
                  aria-invalid={codeBad}
                  placeholder="TEST12345"
                />
                {codeBad ? <p className="text-xs text-destructive">{t('Only letters, numbers, - and _.')}</p> : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void onSave()} disabled={!canWrite || saving || !dirty || datasetBad || tokenBad || codeBad}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                {t('Save settings')}
              </Button>
              <Button variant="outline" onClick={() => void onTest()} disabled={!canWrite || testing || !hasToken || dirty}>
                {testing ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                {t('Send test event')}
              </Button>
            </div>
            {testResult ? (
              <p role="status" data-no-translate className={cn('text-sm', testResult.ok ? 'text-foreground' : 'text-destructive')}>
                {testResult.message}
              </p>
            ) : null}

            <div className="space-y-3 border-t border-border pt-4">
              <ToggleRow
                label={t('Integration on')}
                hint={t('Turn off to stop sending without losing the settings.')}
                checked={Boolean(s?.enabled)}
                disabled={!canWrite || saving || !hasToken || !s?.dataset_id}
                onChange={(v) => void save({ enabled: v })}
              />
              <ToggleRow
                label={t('Send when a lead is created')}
                checked={s?.send_lead ?? true}
                disabled={!canWrite || saving}
                onChange={(v) => void save({ send_lead: v })}
              />
              <ToggleRow
                label={t('Send when a deal is won')}
                checked={s?.send_purchase ?? true}
                disabled={!canWrite || saving}
                onChange={(v) => void save({ send_purchase: v })}
              />
            </div>

            <div className="space-y-2 rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">{t('How to set it up')}</p>
              <ol className="list-decimal space-y-1 pl-4">
                <li>{t('In Meta Events Manager, open your dataset and copy its ID.')}</li>
                <li>{t('In Settings, Conversions API, generate an access key and paste it here.')}</li>
                <li>{t('Optional: copy the test code from Test events, send a test event and check it there.')}</li>
              </ol>
              <p>{t('Only customers who came from a Meta ad are sent. Your company is responsible for mentioning this in its privacy policy.')}</p>
            </div>

            <div>
              <h4 className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                {t('Latest sends')}
              </h4>
              {data && data.events.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">{t('Nothing sent yet. Events appear here when a deal from a Meta ad is created or won.')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="px-2 py-2 font-normal">{t('Date and time')}</th>
                        <th className="px-2 py-2 font-normal">{t('Event type')}</th>
                        <th className="px-2 py-2 font-normal">{t('Related deal')}</th>
                        <th className="hidden px-2 py-2 text-right font-normal sm:table-cell">{t('Deal value')}</th>
                        <th className="px-2 py-2 font-normal">{t('Send status')}</th>
                        <th className="w-24 px-2 py-2" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border border-t border-border">
                      {(data?.events ?? []).map((ev) => (
                        <tr key={ev.id} className="align-top">
                          <td className="whitespace-nowrap px-2 py-2 text-muted-foreground">{formatRelative(ev.created_at, language)}</td>
                          <td className="px-2 py-2">{ev.event_name === 'lead' ? t('Lead created') : t('Deal won')}</td>
                          <td className="max-w-[10rem] truncate px-2 py-2" data-no-translate title={ev.deal_title ?? ''}>
                            {ev.deal_title ?? '—'}
                          </td>
                          <td className="hidden px-2 py-2 text-right tabular-nums sm:table-cell">
                            {ev.event_name === 'purchase' && ev.value != null ? formatCurrency(Number(ev.value), ev.currency ?? undefined) : '—'}
                          </td>
                          <td className="px-2 py-2">
                            <SettingsChip variant={STATUS_VARIANT[ev.status]}>{t(STATUS_LABEL[ev.status])}</SettingsChip>
                            {ev.last_error ? (
                              <p className="mt-1 text-xs text-muted-foreground" data-no-translate>
                                {ev.last_error}
                              </p>
                            ) : null}
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            {ev.status === 'failed' ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => void onRetry(ev.id)}
                                disabled={!canWrite || retrying === ev.id}
                              >
                                {retrying === ev.id ? <Loader2 className="size-3.5 animate-spin" /> : null}
                                {t('Try again')}
                              </Button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </SettingsGroup>
    </section>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm text-foreground">{label}</p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} />
    </div>
  );
}
