'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { Check, Copy, KeyRound, Loader2, Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { useLanguage } from '@/hooks/use-language';
import { formatRelative } from '@/lib/automations/trigger-meta';
import {
  API_KEY_SCOPES,
  API_KEY_SCOPE_DESCRIPTIONS,
  DEFAULT_GRACE_HOURS,
  type ApiKeyScope,
} from '@/lib/api-keys/scopes';
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

import { apiJson, useCopy } from './api-webhooks-shared';
import { DANGER_TEXT_BUTTON, SettingsGroup } from './settings-group';
import { SettingsChip } from './settings-chip';

interface ApiKeyRow {
  id: string;
  name: string;
  note: string | null;
  key_prefix: string;
  key_last4: string;
  scopes: string[];
  allowed_cidrs: string[] | null;
  created_at: string;
  last_used_at: string | null;
  last_used_ip: string | null;
  expires_at: string | null;
  state: 'active' | 'revoked' | 'expired';
}

interface RequestLogRow {
  at: string;
  method: string;
  route: string;
  status: number;
  ip: string | null;
}

const GRACE_OPTIONS = [0, 1, 24, 72, 168];

/** Configurações → API e Webhooks: named, scoped, revocable API keys. */
export function ApiKeysGroup() {
  const { t, language } = useLanguage();
  const { copied, copy } = useCopy();
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['messages:send']);
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState<{ secret: string; title: string } | null>(null);
  const [rotating, setRotating] = useState<ApiKeyRow | null>(null);
  const [grace, setGrace] = useState(DEFAULT_GRACE_HOURS);
  const [revoking, setRevoking] = useState<ApiKeyRow | null>(null);
  const [note, setNote] = useState('');
  const [cidrs, setCidrs] = useState('');
  const [logFor, setLogFor] = useState<string | null>(null);
  const [log, setLog] = useState<RequestLogRow[] | null>(null);

  async function toggleLog(id: string) {
    if (logFor === id) return setLogFor(null);
    setLogFor(id);
    setLog(null);
    try {
      const res = await apiJson<{ requests: RequestLogRow[] }>(`/api/api-keys/${id}/requests`);
      setLog(res.requests);
    } catch (err) {
      toast.error(t(err instanceof Error ? err.message : 'Failed to load the request log'));
      setLogFor(null);
    }
  }

  const load = useCallback(async () => {
    try {
      const res = await apiJson<{ keys: ApiKeyRow[] }>('/api/api-keys');
      setKeys(res.keys);
    } catch (err) {
      toast.error(t(err instanceof Error ? err.message : 'Failed to load API keys'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setBusy(true);
    try {
      const res = await apiJson<{ secret: string }>('/api/api-keys', {
        method: 'POST',
        body: JSON.stringify({ name, scopes, note, allowed_cidrs: cidrs }),
      });
      setCreating(false);
      setName('');
      setNote('');
      setCidrs('');
      setReveal({ secret: res.secret, title: t('API key created') });
      await load();
    } catch (err) {
      toast.error(t(err instanceof Error ? err.message : 'Failed to create the API key'));
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    if (!rotating) return;
    setBusy(true);
    try {
      const res = await apiJson<{ secret: string }>(`/api/api-keys/${rotating.id}/rotate`, {
        method: 'POST',
        body: JSON.stringify({ grace_hours: grace }),
      });
      setRotating(null);
      setReveal({ secret: res.secret, title: t('New API key') });
      await load();
    } catch (err) {
      toast.error(t(err instanceof Error ? err.message : 'Failed to rotate the API key'));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!revoking) return;
    setBusy(true);
    try {
      await apiJson(`/api/api-keys/${revoking.id}`, { method: 'DELETE' });
      setRevoking(null);
      toast.success(t('API key revoked'));
      await load();
    } catch (err) {
      toast.error(t(err instanceof Error ? err.message : 'Failed to revoke the API key'));
    } finally {
      setBusy(false);
    }
  }

  const stateChip = (k: ApiKeyRow) => {
    if (k.state === 'revoked') return <SettingsChip variant="bad">{t('Revoked')}</SettingsChip>;
    if (k.state === 'expired') return <SettingsChip variant="bad">{t('Expired')}</SettingsChip>;
    if (k.expires_at) {
      return (
        <SettingsChip variant="warn">
          {t('Valid until')} {new Date(k.expires_at).toLocaleString(language)}
        </SettingsChip>
      );
    }
    return <SettingsChip variant="ok">{t('Active')}</SettingsChip>;
  };

  return (
    <SettingsGroup
      title={t('API keys')}
      description={t(
        'Use a key in the Authorization: Bearer header to call the SempreCRM API from n8n, Zapier or your own systems. The key is shown only once.',
      )}
      action={
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="size-4" />
          {t('New API key')}
        </Button>
      }
    >
      {loading ? (
        <div className="h-12 animate-pulse rounded-lg bg-muted/60" />
      ) : keys.length === 0 ? (
        <div className="py-6 text-center">
          <KeyRound className="mx-auto size-5 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium text-foreground">{t('No API keys yet')}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('Create a key to send messages from other systems.')}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-normal">{t('Name')}</th>
                <th className="px-3 py-2 font-normal">{t('Key')}</th>
                <th className="hidden px-3 py-2 font-normal md:table-cell">{t('Permissions')}</th>
                <th className="hidden px-3 py-2 font-normal md:table-cell">{t('Created')}</th>
                <th className="px-3 py-2 font-normal">{t('Last used')}</th>
                <th className="px-3 py-2 font-normal">{t('Status')}</th>
                <th className="w-px px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border border-t border-border">
              {keys.map((k) => (
                <Fragment key={k.id}>
                <tr className={k.state === 'active' ? '' : 'opacity-60'}>
                  <td className="px-3 py-2.5 font-medium text-foreground">
                    {k.name}
                    {k.note ? <span className="block text-xs font-normal text-muted-foreground">{k.note}</span> : null}
                    {k.allowed_cidrs?.length ? (
                      <span className="block text-[11px] font-normal text-muted-foreground">
                        {t('Only from')} {k.allowed_cidrs.join(', ')}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">
                    {k.key_prefix}…{k.key_last4}
                  </td>
                  <td className="hidden px-3 py-2.5 text-xs text-muted-foreground md:table-cell">
                    {k.scopes.join(', ')}
                  </td>
                  <td className="hidden px-3 py-2.5 text-xs text-muted-foreground md:table-cell">
                    {new Date(k.created_at).toLocaleDateString(language)}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">
                    {formatRelative(k.last_used_at, language)}
                    {k.last_used_ip ? <span className="block font-mono text-[11px]">{k.last_used_ip}</span> : null}
                  </td>
                  <td className="px-3 py-2.5">{stateChip(k)}</td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap">
                    <Button variant="ghost" size="sm" aria-expanded={logFor === k.id} onClick={() => void toggleLog(k.id)}>
                      {t('Requests')}
                    </Button>
                    {k.state === 'active' ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setGrace(DEFAULT_GRACE_HOURS);
                            setRotating(k);
                          }}
                        >
                          <RefreshCw className="size-3.5" />
                          {t('Rotate')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className={DANGER_TEXT_BUTTON}
                          onClick={() => setRevoking(k)}
                        >
                          {t('Revoke')}
                        </Button>
                      </>
                    ) : null}
                  </td>
                </tr>
                {logFor === k.id ? (
                  <tr>
                    <td colSpan={7} className="bg-muted/30 px-3 py-3">
                      {!log ? (
                        <div className="h-8 animate-pulse rounded bg-muted/60" />
                      ) : log.length === 0 ? (
                        <p className="text-xs text-muted-foreground">{t('No requests recorded yet.')}</p>
                      ) : (
                        <ul className="space-y-1 text-xs">
                          {log.map((r, i) => (
                            <li key={`${r.at}-${i}`} className="flex flex-wrap gap-x-3">
                              <span className="text-muted-foreground">{new Date(r.at).toLocaleString(language)}</span>
                              <span className="font-mono">
                                {r.method} {r.route}
                              </span>
                              <span className={r.status >= 400 ? 'font-mono text-destructive' : 'font-mono'}>{r.status}</span>
                              {r.ip ? <span className="font-mono text-muted-foreground">{r.ip}</span> : null}
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        {t('Shows the last 50 requests of the past 7 days.')}
                      </p>
                    </td>
                  </tr>
                ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* create */}
      <Dialog open={creating} onOpenChange={(o) => !busy && setCreating(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('New API key')}</DialogTitle>
            <DialogDescription>
              {t('Give it a name you will recognise (for example "n8n production") and pick what it may do.')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="api-key-name">{t('Name')}</Label>
              <Input
                id="api-key-name"
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
                placeholder="n8n"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="api-key-note">{t('Note (optional)')}</Label>
              <Input id="api-key-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="api-key-cidrs">{t('Allowed IP addresses (optional)')}</Label>
              <textarea
                id="api-key-cidrs"
                value={cidrs}
                onChange={(e) => setCidrs(e.target.value)}
                rows={2}
                placeholder="203.0.113.7, 198.51.100.0/24"
                className="w-full rounded-md border border-border bg-muted px-2 py-1.5 font-mono text-xs text-foreground focus:border-primary focus:outline-none"
              />
              <p className="text-xs text-muted-foreground">
                {t('Leave empty to accept any address. Separate entries with commas or new lines (up to 10).')}
              </p>
            </div>
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-medium text-foreground">{t('Permissions')}</legend>
              {API_KEY_SCOPES.map((s) => (
                <label key={s} className="flex items-start gap-2 text-sm">
                  <Checkbox
                    checked={scopes.includes(s)}
                    onCheckedChange={(v) =>
                      setScopes((cur) => (v === true ? [...cur, s] : cur.filter((x) => x !== s)))
                    }
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-mono text-xs">{s}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t(API_KEY_SCOPE_DESCRIPTIONS[s])}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreating(false)} disabled={busy}>
              {t('Cancel')}
            </Button>
            <Button onClick={create} disabled={busy || name.trim().length === 0 || scopes.length === 0}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('Create key')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* shown once */}
      <Dialog open={!!reveal} onOpenChange={(o) => !o && setReveal(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{reveal?.title}</DialogTitle>
            <DialogDescription>
              {t('Copy it now. For your security it will not be shown again.')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs">
              {reveal?.secret}
            </code>
            <Button
              variant="outline"
              size="icon"
              aria-label={t('Copy')}
              onClick={() => reveal && copy('key', reveal.secret)}
            >
              {copied === 'key' ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setReveal(null)}>{t('I saved the key')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* rotate */}
      <Dialog open={!!rotating} onOpenChange={(o) => !busy && !o && setRotating(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Rotate API key')}</DialogTitle>
            <DialogDescription>
              {t('A new key with the same permissions is created. The old one keeps working during the grace period so you can switch without downtime.')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="grace">{t('Keep the old key working for')}</Label>
            <select
              id="grace"
              value={grace}
              onChange={(e) => setGrace(Number(e.target.value))}
              className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
            >
              {GRACE_OPTIONS.map((h) => (
                <option key={h} value={h}>
                  {h === 0 ? t('Revoke it now') : h < 24 ? `${h} h` : `${h / 24} ${h === 24 ? t('day') : t('days')}`}
                </option>
              ))}
            </select>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRotating(null)} disabled={busy}>
              {t('Cancel')}
            </Button>
            <Button onClick={rotate} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('Rotate key')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* revoke */}
      <Dialog open={!!revoking} onOpenChange={(o) => !busy && !o && setRevoking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Revoke API key')}</DialogTitle>
            <DialogDescription>
              {t('Integrations using this key stop working immediately. This cannot be undone.')}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-foreground">
            {revoking?.name}{' '}
            <span className="font-mono text-xs text-muted-foreground">
              {revoking?.key_prefix}…{revoking?.key_last4}
            </span>
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRevoking(null)} disabled={busy}>
              {t('Cancel')}
            </Button>
            <Button variant="destructive" onClick={revoke} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('Revoke')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  );
}
