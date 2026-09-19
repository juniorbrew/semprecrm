'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Webhook,
} from 'lucide-react';
import { toast } from 'sonner';

import { createClient } from '@/lib/supabase/client';
import { useAuth, useEntitlements } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import {
  DEFAULT_FIELD_MAP,
  LEAD_STANDARD_FIELDS,
  curlExample,
  deleteLeadSource,
  htmlFormExample,
  leadWebhookUrl,
  listLeadSourceEvents,
  listLeadSources,
  normalizeFieldMap,
  resolveSiteUrl,
  updateLeadSource,
  type LeadSourcePatch,
  type LeadStandardField,
} from '@/lib/lead-capture';
import { formatRelative } from '@/lib/automations/trigger-meta';
import type {
  AccountMember,
  CustomField,
  LeadSource,
  LeadSourceEvent,
  LeadSourceFieldMap,
  Pipeline,
  PipelineStage,
  Tag,
} from '@/types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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

import { SettingsPanelHead } from './settings-panel-head';

const SELECT_CLASS =
  'w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none';

const STANDARD_FIELD_LABELS: Record<LeadStandardField, string> = {
  name: 'Name',
  phone: 'Phone',
  email: 'Email',
  company: 'Company',
};

type DialogState =
  | { mode: 'closed' }
  | { mode: 'create' }
  | { mode: 'edit'; source: LeadSource };

interface Resources {
  pipelines: Pipeline[];
  stages: PipelineStage[];
  tags: Tag[];
  members: AccountMember[];
  customFields: CustomField[];
}

const EMPTY_RESOURCES: Resources = {
  pipelines: [],
  stages: [],
  tags: [],
  members: [],
  customFields: [],
};

/**
 * Configurações → Integrações: the account's lead sources (webhook
 * endpoints that turn a form post into contact + deal + tags). Admin+
 * only — the token is the source's credential. Module `lead_capture`.
 */
export function LeadSourcesSettings() {
  const supabase = useMemo(() => createClient(), []);
  const { t, language } = useLanguage();
  const { accountId, canManageMembers, profileLoading } = useAuth();
  const entitlements = useEntitlements();
  const moduleOn = entitlements.modules.lead_capture;

  const [sources, setSources] = useState<LeadSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>({ mode: 'closed' });
  const [toDelete, setToDelete] = useState<LeadSource | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [resources, setResources] = useState<Resources>(EMPTY_RESOURCES);

  const reload = useCallback(async () => {
    if (!accountId) return;
    try {
      const rows = await listLeadSources(supabase, accountId);
      setSources(rows);
    } catch (err) {
      console.error(err);
      toast.error(t('Failed to load lead sources'));
    } finally {
      setLoading(false);
    }
  }, [accountId, supabase, t]);

  useEffect(() => {
    if (!accountId || !canManageMembers) return;
    void reload();
  }, [accountId, canManageMembers, reload]);

  // Pickers for the dialog: pipelines/stages/tags/custom fields via RLS,
  // members via the API (email-visibility rules live there).
  useEffect(() => {
    if (!accountId || !canManageMembers) return;
    let cancelled = false;
    void (async () => {
      const [pipelinesRes, stagesRes, tagsRes, fieldsRes] = await Promise.all([
        supabase.from('pipelines').select('*').eq('account_id', accountId).order('name'),
        supabase.from('pipeline_stages').select('*').order('position'),
        supabase.from('tags').select('*').eq('account_id', accountId).order('name'),
        supabase.from('custom_fields').select('*').eq('account_id', accountId).order('field_name'),
      ]);
      let members: AccountMember[] = [];
      try {
        const res = await fetch('/api/account/members', { cache: 'no-store' });
        if (res.ok) members = ((await res.json()) as { members?: AccountMember[] }).members ?? [];
      } catch {
        // No members endpoint — assignee picker stays empty.
      }
      if (cancelled) return;
      setResources({
        pipelines: (pipelinesRes.data as Pipeline[] | null) ?? [],
        stages: (stagesRes.data as PipelineStage[] | null) ?? [],
        tags: (tagsRes.data as Tag[] | null) ?? [],
        members,
        customFields: (fieldsRes.data as CustomField[] | null) ?? [],
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, canManageMembers, supabase]);

  const selected = sources.find((s) => s.id === selectedId) ?? null;

  function replaceSource(saved: LeadSource) {
    setSources((prev) => {
      const idx = prev.findIndex((s) => s.id === saved.id);
      if (idx === -1) return [...prev, saved];
      const next = prev.slice();
      next[idx] = saved;
      return next;
    });
  }

  async function toggleActive(source: LeadSource, isActive: boolean) {
    try {
      const saved = await updateLeadSource(supabase, source.id, { is_active: isActive });
      replaceSource(saved);
      toast.success(isActive ? t('Source activated') : t('Source paused'));
    } catch (err) {
      console.error(err);
      toast.error(t('Failed to save lead source'));
    }
  }

  async function handleDelete() {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await deleteLeadSource(supabase, toDelete.id);
      setSources((prev) => prev.filter((s) => s.id !== toDelete.id));
      if (selectedId === toDelete.id) setSelectedId(null);
      setToDelete(null);
      toast.success(t('Lead source deleted'));
    } catch (err) {
      console.error(err);
      toast.error(t('Failed to delete lead source'));
    } finally {
      setDeleting(false);
    }
  }

  // ---- gates ---------------------------------------------------------
  if (profileLoading || !entitlements.ready) {
    return (
      <section className="max-w-4xl animate-in fade-in-50 duration-200">
        <SettingsPanelHead title={t('Integrations')} />
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-muted/60" />
          ))}
        </div>
      </section>
    );
  }

  if (!canManageMembers) {
    return (
      <section className="max-w-4xl animate-in fade-in-50 duration-200">
        <SettingsPanelHead title={t('Integrations')} />
        <Alert className="border-border bg-card">
          <AlertTitle className="mb-1 text-foreground">{t('Admins only')}</AlertTitle>
          <AlertDescription className="text-sm text-muted-foreground">
            {t('Only account admins can manage lead sources — the webhook URL is a credential.')}
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  if (!moduleOn) {
    return (
      <section className="max-w-4xl animate-in fade-in-50 duration-200">
        <SettingsPanelHead
          title={t('Integrations')}
          description={t('Receive leads from landing pages, forms, Zapier and n8n straight into the CRM.')}
        />
        <Alert className="border-border bg-card">
          <AlertTitle className="mb-1 text-foreground">{t('Module not included in your plan')}</AlertTitle>
          <AlertDescription className="text-sm text-muted-foreground">
            {t('Lead capture by webhook is not part of your current plan. Get in touch with the SempreCRM team to add it.')}
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  return (
    <section className="max-w-4xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t('Integrations')}
        description={t(
          'Each lead source gets its own webhook URL. Post a form to it and the lead becomes a contact (deduplicated by phone), lands in the pipeline you choose, gets tagged and fires your automations.',
        )}
        action={
          <Button
            size="sm"
            onClick={() => setDialog({ mode: 'create' })}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            {t('New lead source')}
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Webhook className="size-4 text-primary" />
            {t('Lead sources')}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('Pick a source to see its URL, examples and the latest submissions.')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              {[1, 2].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded-lg bg-muted/60" />
              ))}
            </div>
          ) : sources.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center">
              <Webhook className="mx-auto h-6 w-6 text-muted-foreground" />
              <p className="mt-2 text-sm font-medium text-foreground">{t('No lead sources yet')}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('Create one per landing page or form — each gets its own URL and counters.')}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDialog({ mode: 'create' })}
                className="mt-3 border-border bg-transparent text-muted-foreground hover:bg-muted"
              >
                <Plus className="h-3 w-3" />
                {t('New lead source')}
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">{t('Name')}</th>
                    <th className="px-3 py-2 font-medium">{t('Active')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('Received')}</th>
                    <th className="hidden px-3 py-2 font-medium md:table-cell">{t('Last received')}</th>
                    <th className="w-24 px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {sources.map((source) => {
                    const isSelected = source.id === selectedId;
                    return (
                      <tr
                        key={source.id}
                        className={cn(
                          'cursor-pointer border-t border-border align-middle transition-colors hover:bg-muted/40',
                          isSelected && 'bg-primary-soft/40',
                        )}
                        onClick={() => setSelectedId(isSelected ? null : source.id)}
                        aria-selected={isSelected}
                      >
                        <td className="px-3 py-2 font-medium text-foreground">
                          <span className="flex items-center gap-1.5">
                            {isSelected ? (
                              <ChevronDown className="size-3.5 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="size-3.5 text-muted-foreground" />
                            )}
                            {source.name}
                          </span>
                        </td>
                        <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                          <Switch
                            checked={source.is_active}
                            onCheckedChange={(checked) => void toggleActive(source, checked)}
                            aria-label={source.is_active ? t('Active') : t('Paused source')}
                          />
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-foreground">
                          {source.received_count}
                        </td>
                        <td className="hidden px-3 py-2 text-muted-foreground md:table-cell">
                          {formatRelative(source.last_received_at, language)}
                        </td>
                        <td className="px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
                          <div className="flex justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => setDialog({ mode: 'edit', source })}
                              aria-label={t('Edit')}
                              title={t('Edit')}
                              className="flex h-8 w-8 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setToDelete(source)}
                              aria-label={t('Delete')}
                              title={t('Delete')}
                              className="flex h-8 w-8 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-500"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {selected && (
        <SourceDetail
          key={selected.id}
          source={selected}
          resources={resources}
          onSourceChange={replaceSource}
          onRefresh={reload}
        />
      )}

      {dialog.mode !== 'closed' && accountId && (
        <LeadSourceDialog
          source={dialog.mode === 'edit' ? dialog.source : null}
          resources={resources}
          onClose={() => setDialog({ mode: 'closed' })}
          onSave={async (input) => {
            if (dialog.mode === 'edit') {
              const saved = await updateLeadSource(supabase, dialog.source.id, input);
              replaceSource(saved);
              toast.success(t('Lead source saved'));
            } else {
              const res = await fetch('/api/lead-sources', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(input),
              });
              if (!res.ok) {
                const json = (await res.json().catch(() => ({}))) as { error?: string };
                throw new Error(json.error || `HTTP ${res.status}`);
              }
              const { source } = (await res.json()) as { source: LeadSource };
              replaceSource({ ...source, field_map: normalizeFieldMap(source.field_map) });
              setSelectedId(source.id);
              toast.success(t('Lead source created'));
            }
          }}
        />
      )}

      <Dialog
        open={toDelete !== null}
        onOpenChange={(open) => {
          if (!open) setToDelete(null);
        }}
      >
        <DialogContent className="border-border bg-popover sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t('Delete lead source?')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {toDelete?.name}. {t('Its URL stops working immediately and the submission log is removed. Contacts and deals stay.')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="border-border bg-popover">
            <Button
              variant="outline"
              onClick={() => setToDelete(null)}
              disabled={deleting}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('Cancel')}
            </Button>
            <Button
              onClick={() => void handleDelete()}
              disabled={deleting}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {deleting ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('Delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

// ------------------------------------------------------------
// Source detail: URL, examples, token rotation, latest events
// ------------------------------------------------------------

function useCopy() {
  const { t } = useLanguage();
  const [copied, setCopied] = useState<string | null>(null);
  const copy = useCallback(
    async (key: string, text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(key);
        setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
      } catch {
        toast.error(t('Could not copy'));
      }
    },
    [t],
  );
  return { copied, copy };
}

function SourceDetail({
  source,
  resources,
  onSourceChange,
  onRefresh,
}: {
  source: LeadSource;
  resources: Resources;
  onSourceChange: (s: LeadSource) => void;
  /** Re-reads the source list so the counters catch up with the log. */
  onRefresh: () => Promise<void>;
}) {
  const supabase = useMemo(() => createClient(), []);
  const { t } = useLanguage();
  const { copied, copy } = useCopy();
  const [events, setEvents] = useState<LeadSourceEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [openEvent, setOpenEvent] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [siteUrl, setSiteUrl] = useState(() => resolveSiteUrl(process.env.NEXT_PUBLIC_SITE_URL, undefined));

  // `window.location.origin` is only known on the client.
  useEffect(() => {
    setSiteUrl(resolveSiteUrl());
  }, []);

  const url = leadWebhookUrl(source.token, siteUrl);
  const curl = curlExample(url, source.field_map);
  const html = htmlFormExample(url, source.field_map);

  const loadEvents = useCallback(async () => {
    setEventsLoading(true);
    try {
      const [rows] = await Promise.all([listLeadSourceEvents(supabase, source.id), onRefresh()]);
      setEvents(rows);
    } catch (err) {
      console.error(err);
      toast.error(t('Failed to load submissions'));
    } finally {
      setEventsLoading(false);
    }
  }, [source.id, supabase, t, onRefresh]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  async function rotateToken() {
    setRotating(true);
    try {
      const res = await fetch(`/api/lead-sources/${source.id}/token`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { source: saved } = (await res.json()) as { source: LeadSource };
      onSourceChange({ ...saved, field_map: normalizeFieldMap(saved.field_map) });
      setConfirmRotate(false);
      toast.success(t('New token generated — update your forms with the new URL.'));
    } catch (err) {
      console.error(err);
      toast.error(t('Failed to generate a new token'));
    } finally {
      setRotating(false);
    }
  }

  const pipeline = resources.pipelines.find((p) => p.id === source.pipeline_id);
  const stage = resources.stages.find((s) => s.id === source.stage_id);
  const assignee = resources.members.find((m) => m.user_id === source.assignee_user_id);
  const tags = source.tag_ids
    .map((id) => resources.tags.find((tg) => tg.id === id))
    .filter((tg): tg is Tag => Boolean(tg));

  return (
    <div className="mt-4 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">{source.name}</CardTitle>
          <CardDescription className="text-muted-foreground">
            {pipeline && stage
              ? `${t('Deals go to')} ${pipeline.name} → ${stage.name}`
              : t('No deal is created — the lead becomes a contact only.')}
            {assignee ? ` · ${t('Assigned to')} ${assignee.full_name}` : ''}
            {tags.length > 0 ? ` · ${t('Tags')}: ${tags.map((tg) => tg.name).join(', ')}` : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label className="text-muted-foreground">{t('Webhook URL')}</Label>
            <div className="mt-1 flex gap-2">
              <Input readOnly value={url} className="border-border bg-muted font-mono text-xs text-foreground" />
              <Button
                variant="outline"
                size="sm"
                onClick={() => void copy('url', url)}
                className="shrink-0 border-border text-muted-foreground hover:bg-muted"
              >
                {copied === 'url' ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
                {t('Copy')}
              </Button>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t('Accepts POST with JSON, form-urlencoded or multipart. Opening it in a browser shows { ok: true }.')}
            </p>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <CodeBlock
              label={t('curl example')}
              code={curl}
              copied={copied === 'curl'}
              onCopy={() => void copy('curl', curl)}
            />
            <CodeBlock
              label={t('HTML form example')}
              code={html}
              copied={copied === 'html'}
              onCopy={() => void copy('html', html)}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3">
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <KeyRound className="mt-0.5 size-4 shrink-0" />
              <span>{t('Generating a new token changes the URL. Every form still posting to the old one will get 404.')}</span>
            </div>
            {confirmRotate ? (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={rotating}
                  onClick={() => setConfirmRotate(false)}
                  className="border-border text-muted-foreground hover:bg-muted"
                >
                  {t('Cancel')}
                </Button>
                <Button
                  size="sm"
                  disabled={rotating}
                  onClick={() => void rotateToken()}
                  className="bg-red-600 text-white hover:bg-red-700"
                >
                  {rotating ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                  {t('Yes, generate new token')}
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmRotate(true)}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                <RefreshCw className="size-4" />
                {t('Generate new token')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="text-foreground">{t('Latest submissions')}</CardTitle>
              <CardDescription className="text-muted-foreground">
                {t('The last 50 payloads received, newest first. Click a row to see the payload.')}
              </CardDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void loadEvents()}
              disabled={eventsLoading}
              aria-label={t('Refresh')}
              className="text-muted-foreground"
            >
              <RefreshCw className={cn('size-4', eventsLoading && 'animate-spin')} />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {eventsLoading && events.length === 0 ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-10 animate-pulse rounded-lg bg-muted/60" />
              ))}
            </div>
          ) : events.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {t('Nothing received yet. Try the curl example above.')}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">{t('Status')}</th>
                    <th className="px-3 py-2 font-medium">{t('Contact')}</th>
                    <th className="px-3 py-2 font-medium">{t('When')}</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((ev) => {
                    const open = openEvent === ev.id;
                    return (
                      <EventRow
                        key={ev.id}
                        event={ev}
                        open={open}
                        onToggle={() => setOpenEvent(open ? null : ev.id)}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CodeBlock({
  label,
  code,
  copied,
  onCopy,
}: {
  label: string;
  code: string;
  copied: boolean;
  onCopy: () => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between">
        <Label className="text-muted-foreground">{label}</Label>
        <button
          type="button"
          onClick={onCopy}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
          {t('Copy')}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-lg border border-border bg-muted p-3 font-mono text-[11px] leading-relaxed text-foreground">
        {code}
      </pre>
    </div>
  );
}

const STATUS_STYLE: Record<LeadSourceEvent['status'], { label: string; className: string }> = {
  ok: { label: 'Contact created', className: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30' },
  duplicate: { label: 'Existing contact', className: 'bg-amber-500/10 text-amber-600 border-amber-500/30' },
  error: { label: 'Error', className: 'bg-red-500/10 text-red-600 border-red-500/30' },
};

const ERROR_LABELS: Record<string, string> = {
  phone_missing: 'Phone missing from payload',
  phone_invalid: 'Invalid phone number',
  account_owner_not_found: 'Account owner not found',
};

function EventRow({
  event,
  open,
  onToggle,
}: {
  event: LeadSourceEvent;
  open: boolean;
  onToggle: () => void;
}) {
  const { t, language } = useLanguage();
  const style = STATUS_STYLE[event.status] ?? STATUS_STYLE.error;
  const errorText = event.error
    ? t(ERROR_LABELS[event.error] ?? event.error)
    : null;
  return (
    <>
      <tr
        className="cursor-pointer border-t border-border align-middle transition-colors hover:bg-muted/40"
        onClick={onToggle}
        aria-expanded={open}
      >
        <td className="px-3 py-2">
          <span className="flex items-center gap-1.5">
            {open ? (
              <ChevronDown className="size-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3.5 text-muted-foreground" />
            )}
            <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium', style.className)}>
              {t(style.label)}
            </span>
            {errorText ? (
              <span className="flex items-center gap-1 text-xs text-red-600">
                <AlertTriangle className="size-3" />
                {errorText}
              </span>
            ) : null}
          </span>
        </td>
        <td className="px-3 py-2 text-foreground">
          {event.contact ? (
            <span>
              {event.contact.name || event.contact.phone}
              <span className="ml-1 text-xs text-muted-foreground">{event.contact.phone}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
        <td className="whitespace-nowrap px-3 py-2 text-muted-foreground" title={new Date(event.created_at).toLocaleString(language)}>
          {formatRelative(event.created_at, language)}
        </td>
      </tr>
      {open ? (
        <tr className="border-t border-border bg-muted/30">
          <td colSpan={3} className="px-3 py-2">
            <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed text-foreground">
              {JSON.stringify(event.payload, null, 2)}
            </pre>
            {event.deal_id ? (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t('Deal created')}: <code className="font-mono">{event.deal_id}</code>
              </p>
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

// ------------------------------------------------------------
// Create / edit dialog
// ------------------------------------------------------------

interface CustomRow {
  fieldId: string;
  key: string;
}

function LeadSourceDialog({
  source,
  resources,
  onClose,
  onSave,
}: {
  source: LeadSource | null;
  resources: Resources;
  onClose: () => void;
  onSave: (input: LeadSourcePatch & { name: string }) => Promise<void>;
}) {
  const { t } = useLanguage();
  const [name, setName] = useState(source?.name ?? '');
  const [pipelineId, setPipelineId] = useState(source?.pipeline_id ?? '');
  const [stageId, setStageId] = useState(source?.stage_id ?? '');
  const [tagIds, setTagIds] = useState<string[]>(source?.tag_ids ?? []);
  const [assignee, setAssignee] = useState(source?.assignee_user_id ?? '');
  const [standardMap, setStandardMap] = useState<Record<LeadStandardField, string>>({
    name: source?.field_map.name ?? '',
    phone: source?.field_map.phone ?? '',
    email: source?.field_map.email ?? '',
    company: source?.field_map.company ?? '',
  });
  const [customRows, setCustomRows] = useState<CustomRow[]>(
    Object.entries(source?.field_map.custom ?? {}).map(([fieldId, key]) => ({ fieldId, key })),
  );
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const stages = resources.stages.filter((s) => s.pipeline_id === pipelineId);
  const nameError = name.trim() ? null : t('Name is required');
  const stageError = pipelineId && !stageId ? t('Pick the stage new deals start in') : null;
  const valid = !nameError && !stageError;

  function buildFieldMap(): LeadSourceFieldMap {
    const custom: Record<string, string> = {};
    for (const row of customRows) {
      if (row.fieldId && row.key.trim()) custom[row.fieldId] = row.key.trim();
    }
    return normalizeFieldMap({ ...standardMap, custom });
  }

  async function submit() {
    setSubmitted(true);
    if (!valid || saving) return;
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        pipeline_id: pipelineId || null,
        stage_id: pipelineId ? stageId || null : null,
        tag_ids: tagIds,
        assignee_user_id: assignee || null,
        field_map: buildFieldMap(),
      });
      onClose();
    } catch (err) {
      console.error(err);
      toast.error(t('Failed to save lead source'));
    } finally {
      setSaving(false);
    }
  }

  const usedCustomIds = new Set(customRows.map((r) => r.fieldId));

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto border-border bg-popover sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {source ? t('Edit lead source') : t('New lead source')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('Where leads from this source land and which payload keys feed each CRM field.')}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="lead-source-name" className="text-muted-foreground">
              {t('Name')}
            </Label>
            <Input
              id="lead-source-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('e.g. Landing page — winter campaign')}
              autoFocus
              className="border-border bg-muted text-foreground"
            />
            {submitted && nameError ? <p className="text-xs text-red-500">{nameError}</p> : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t('Pipeline')}</Label>
              <select
                value={pipelineId}
                onChange={(e) => {
                  setPipelineId(e.target.value);
                  setStageId('');
                }}
                className={SELECT_CLASS}
              >
                <option value="">{t("Don't create a deal")}</option>
                {resources.pipelines.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t('Stage')}</Label>
              <select
                value={stageId}
                onChange={(e) => setStageId(e.target.value)}
                disabled={!pipelineId}
                className={SELECT_CLASS}
              >
                <option value="">{pipelineId ? t('Pick a stage') : '—'}</option>
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              {submitted && stageError ? <p className="text-xs text-red-500">{stageError}</p> : null}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t('Assigned to')}</Label>
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className={SELECT_CLASS}>
                <option value="">{t('Unassigned')}</option>
                {resources.members.map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.full_name || m.email || m.user_id}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t('Tags')}</Label>
              {resources.tags.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('No tags yet')}</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {resources.tags.map((tag) => {
                    const on = tagIds.includes(tag.id);
                    return (
                      <button
                        key={tag.id}
                        type="button"
                        onClick={() =>
                          setTagIds((prev) => (on ? prev.filter((id) => id !== tag.id) : [...prev, tag.id]))
                        }
                        aria-pressed={on}
                        className={cn(
                          'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
                          on
                            ? 'border-primary bg-primary-soft text-primary'
                            : 'border-border text-muted-foreground hover:bg-muted',
                        )}
                      >
                        <span className="size-2 rounded-full" style={{ backgroundColor: tag.color }} aria-hidden />
                        {tag.name}
                        {on ? <Check className="size-3" /> : null}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <div>
              <Label className="text-muted-foreground">{t('Field mapping')}</Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t('CRM field ← payload key. Leave blank to use the default key (name, phone, email, company — Portuguese aliases work too). Dotted paths like lead.phone work.')}
              </p>
            </div>
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <tbody>
                  {LEAD_STANDARD_FIELDS.map((field) => (
                    <tr key={field} className="border-t border-border first:border-t-0">
                      <td className="w-40 px-3 py-1.5 text-foreground">{t(STANDARD_FIELD_LABELS[field])}</td>
                      <td className="w-6 text-center text-muted-foreground">←</td>
                      <td className="px-2 py-1.5">
                        <Input
                          value={standardMap[field]}
                          onChange={(e) => setStandardMap((m) => ({ ...m, [field]: e.target.value }))}
                          placeholder={DEFAULT_FIELD_MAP[field]}
                          aria-label={`${t(STANDARD_FIELD_LABELS[field])} ← ${t('payload key')}`}
                          className="h-8 border-border bg-muted font-mono text-xs text-foreground"
                        />
                      </td>
                      <td className="w-9" />
                    </tr>
                  ))}
                  {customRows.map((row, i) => (
                    <tr key={i} className="border-t border-border">
                      <td className="w-40 px-2 py-1.5">
                        <select
                          value={row.fieldId}
                          onChange={(e) =>
                            setCustomRows((rows) => rows.map((r, j) => (j === i ? { ...r, fieldId: e.target.value } : r)))
                          }
                          className={cn(SELECT_CLASS, 'h-8 py-1 text-xs')}
                          aria-label={t('Custom field')}
                        >
                          <option value="">{t('Custom field…')}</option>
                          {resources.customFields.map((cf) => (
                            <option
                              key={cf.id}
                              value={cf.id}
                              disabled={cf.id !== row.fieldId && usedCustomIds.has(cf.id)}
                            >
                              {cf.field_name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="w-6 text-center text-muted-foreground">←</td>
                      <td className="px-2 py-1.5">
                        <Input
                          value={row.key}
                          onChange={(e) =>
                            setCustomRows((rows) => rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))
                          }
                          placeholder={t('payload key')}
                          aria-label={t('payload key')}
                          className="h-8 border-border bg-muted font-mono text-xs text-foreground"
                        />
                      </td>
                      <td className="w-9 pr-2">
                        <button
                          type="button"
                          onClick={() => setCustomRows((rows) => rows.filter((_, j) => j !== i))}
                          aria-label={t('Remove')}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-red-500/10 hover:text-red-500"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {resources.customFields.length > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setCustomRows((rows) => [...rows, { fieldId: '', key: '' }])}
                disabled={customRows.length >= resources.customFields.length}
                className="border-border bg-transparent text-muted-foreground hover:bg-muted"
              >
                <Plus className="size-3.5" />
                {t('Map a custom field')}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t('Create custom fields in Settings → Fields and tags to map extra payload keys.')}
              </p>
            )}
          </div>

          <DialogFooter className="border-border bg-popover">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={saving}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('Cancel')}
            </Button>
            <Button type="submit" disabled={saving} className="bg-primary text-primary-foreground hover:bg-primary/90">
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {source ? t('Save') : t('Create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
