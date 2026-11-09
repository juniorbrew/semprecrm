'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import {
  BOT_LIMITS,
  defaultBotConfig,
  normalizeDomain,
  validateBotConfig,
  type BotConfig,
  type BotQuestion,
  type BotQuestionType,
} from '@/lib/site-bot';
import type { AccountMember, CustomField, LeadSource, Pipeline, PipelineStage, Tag } from '@/types';
import { Button } from '@/components/ui/button';
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
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

import { SiteBotPreview } from './site-bot-preview';

const SELECT_CLASS =
  'w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none';

/** Pickers shared with the webhook source dialog. */
export interface BotResources {
  pipelines: Pipeline[];
  stages: PipelineStage[];
  tags: Tag[];
  members: AccountMember[];
  customFields: CustomField[];
}

interface Number_ {
  label: string;
  digits: string;
}

const OTHER_NUMBER = '__other__';

function readConfig(source: LeadSource | null): BotConfig {
  const parsed = source ? validateBotConfig(source.bot_config) : null;
  return parsed?.ok ? parsed.config : defaultBotConfig();
}

function nextQuestionId(questions: BotQuestion[]): string {
  const used = new Set(questions.map((q) => q.id));
  for (let n = questions.length + 1; ; n++) if (!used.has(`q${n}`)) return `q${n}`;
}

/** Connected numbers of the account: the QR session and the Meta channel (best effort). */
function useConnectedNumbers(accountId: string | null): Number_[] {
  const supabase = useMemo(() => createClient(), []);
  const [numbers, setNumbers] = useState<Number_[]>([]);
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void (async () => {
      const found: Number_[] = [];
      try {
        const { data } = await supabase
          .from('wa_qr_sessions')
          .select('phone_number, status')
          .eq('account_id', accountId)
          .maybeSingle();
        const row = data as { phone_number?: string | null; status?: string } | null;
        const digits = (row?.phone_number ?? '').replace(/\D/g, '');
        if (row?.status === 'connected' && digits) found.push({ label: `+${digits}`, digits });
      } catch {
        // No QR session: nothing to offer from there.
      }
      try {
        const res = await fetch('/api/whatsapp/config', { cache: 'no-store' });
        if (res.ok) {
          const json = (await res.json()) as { connected?: boolean; phone_info?: { display_phone_number?: string } };
          const digits = (json.phone_info?.display_phone_number ?? '').replace(/\D/g, '');
          if (json.connected && digits && !found.some((n) => n.digits === digits)) {
            found.push({ label: json.phone_info?.display_phone_number ?? `+${digits}`, digits });
          }
        }
      } catch {
        // The official channel may not be set up.
      }
      if (!cancelled) setNumbers(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, supabase]);
  return numbers;
}

export function SiteBotEditor({
  source,
  resources,
  onClose,
  onSaved,
}: {
  source: LeadSource | null;
  resources: BotResources;
  onClose: () => void;
  onSaved: (saved: LeadSource) => void;
}) {
  const { t } = useLanguage();
  const { accountId } = useAuth();
  const numbers = useConnectedNumbers(accountId);

  const [name, setName] = useState(source?.name ?? '');
  const [isActive, setIsActive] = useState(source?.is_active ?? true);
  const [pipelineId, setPipelineId] = useState(source?.pipeline_id ?? '');
  const [stageId, setStageId] = useState(source?.stage_id ?? '');
  const [tagIds, setTagIds] = useState<string[]>(source?.tag_ids ?? []);
  const [assignee, setAssignee] = useState(source?.assignee_user_id ?? '');
  const [cfg, setCfg] = useState<BotConfig>(() => readConfig(source));
  const [domainsText, setDomainsText] = useState(() => readConfig(source).domains.join('\n'));
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const stages = resources.stages.filter((s) => s.pipeline_id === pipelineId);

  const domainTokens = domainsText
    .split(/[\n,;\s]+/)
    .map((d) => d.trim())
    .filter(Boolean);
  const parsedDomains = domainTokens.map((d) => normalizeDomain(d));
  const config: BotConfig = { ...cfg, domains: parsedDomains.filter((d): d is string => d !== null) };

  const matchesNumber = numbers.some((n) => n.digits === cfg.end.whatsappNumber);
  const numberChoice = !cfg.end.whatsappNumber ? '' : matchesNumber ? cfg.end.whatsappNumber : OTHER_NUMBER;

  // ---- what to fix, in the user's words ---------------------------------
  const issues: string[] = [];
  if (!name.trim()) issues.push(t('Give the bot a name to find it in the list.'));
  if (!cfg.appearance.botName.trim()) issues.push(t('Write the name the visitor sees on the bot.'));
  if (!cfg.greeting.trim()) issues.push(t('Write the first message of the bot.'));
  if (cfg.questions.some((q) => !q.text.trim())) issues.push(t('Every question needs a text.'));
  if (cfg.questions.some((q) => q.type === 'choice' && (q.options ?? []).some((o) => !o.trim()))) {
    issues.push(t('Fill in or remove the empty answer options.'));
  }
  if (cfg.questions.some((q) => q.type === 'choice' && new Set(q.options).size !== (q.options ?? []).length)) {
    issues.push(t('Answer options must be different from each other.'));
  }
  if (cfg.questions.some((q) => q.target === 'custom' && !q.customFieldId)) {
    issues.push(t('Pick the contact field that stores each answer.'));
  }
  if (pipelineId && !stageId) issues.push(t('Pick the stage where new deals start.'));
  if (cfg.end.whatsappEnabled && !/^[1-9]\d{9,14}$/.test(cfg.end.whatsappNumber)) {
    issues.push(t('Choose or type the WhatsApp number, with country and area code.'));
  }
  if (!cfg.lgpd.text.trim()) issues.push(t('Write the consent text the visitor accepts.'));
  if (cfg.lgpd.linkUrl.trim() && !/^https:\/\//i.test(cfg.lgpd.linkUrl.trim())) {
    issues.push(t('The privacy policy link must start with https://'));
  }
  if (parsedDomains.some((d) => d === null)) issues.push(t('One of the site addresses is not valid.'));

  const set = <K extends keyof BotConfig>(key: K, value: BotConfig[K]) => setCfg((c) => ({ ...c, [key]: value }));
  const setAppearance = (patch: Partial<BotConfig['appearance']>) => set('appearance', { ...cfg.appearance, ...patch });
  const setEnd = (patch: Partial<BotConfig['end']>) => set('end', { ...cfg.end, ...patch });
  const setQuestion = (i: number, patch: Partial<BotQuestion>) =>
    set('questions', cfg.questions.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= cfg.questions.length) return;
    const next = cfg.questions.slice();
    [next[i], next[j]] = [next[j], next[i]];
    set('questions', next);
  };

  function changeType(i: number, type: BotQuestionType) {
    const q = cfg.questions[i];
    const next: BotQuestion = { id: q.id, text: q.text, type, required: q.required };
    if (type === 'choice') next.options = q.options?.length ? q.options : ['', ''];
    if (type === 'text' || type === 'choice') next.target = q.target ?? 'note';
    if (q.customFieldId && next.target === 'custom') next.customFieldId = q.customFieldId;
    set('questions', cfg.questions.map((x, j) => (j === i ? next : x)));
  }

  function addQuestion() {
    if (cfg.questions.length >= BOT_LIMITS.maxQuestions) return;
    set('questions', [
      ...cfg.questions,
      { id: nextQuestionId(cfg.questions), text: '', type: 'text', required: false, target: 'note' },
    ]);
  }

  async function submit() {
    setSubmitted(true);
    if (issues.length > 0 || saving) return;
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        is_active: isActive,
        pipeline_id: pipelineId || null,
        stage_id: pipelineId ? stageId || null : null,
        tag_ids: tagIds,
        assignee_user_id: assignee || null,
        config,
      };
      const res = await fetch(source ? `/api/site-bots/${source.id}` : '/api/site-bots', {
        method: source ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.error('[site-bot] save failed', res.status, await res.json().catch(() => ({})));
        toast.error(t('Some bot settings need attention. Check them and save again.'));
        return;
      }
      const { source: saved } = (await res.json()) as { source: LeadSource };
      toast.success(source ? t('Bot saved') : t('Bot created'));
      onSaved(saved);
      onClose();
    } catch (err) {
      console.error(err);
      toast.error(t('Failed to save the bot'));
    } finally {
      setSaving(false);
    }
  }

  const checkedMark = <Check className="size-3" />;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[92vh] overflow-y-auto border-border bg-popover sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{source ? t('Edit site bot') : t('New site bot')}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('The bot asks your questions on your website and turns the answers into a lead in the pipeline.')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
          <form
            className="space-y-6"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {/* identity */}
            <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
              <div className="grid gap-2">
                <Label htmlFor="bot-name" className="text-muted-foreground">
                  {t('Bot name in this list')}
                </Label>
                <Input
                  id="bot-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('e.g. Store website bot')}
                  maxLength={80}
                  className="border-border bg-muted text-foreground"
                />
              </div>
              <div className="flex items-center gap-2 pb-1.5">
                <Switch checked={isActive} onCheckedChange={setIsActive} aria-label={t('Bot is on')} />
                <span className="text-sm text-foreground">{t('Bot is on')}</span>
              </div>
            </div>

            {/* appearance */}
            <fieldset className="grid gap-4 sm:grid-cols-2">
              <legend className="mb-2 text-sm font-medium text-foreground">{t('Appearance')}</legend>
              <div className="grid gap-2">
                <Label htmlFor="bot-title" className="text-muted-foreground">{t('Name shown to the visitor')}</Label>
                <Input
                  id="bot-title"
                  value={cfg.appearance.botName}
                  maxLength={BOT_LIMITS.botName}
                  onChange={(e) => setAppearance({ botName: e.target.value })}
                  className="border-border bg-muted text-foreground"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="bot-bubble" className="text-muted-foreground">{t('Text next to the bubble')}</Label>
                <Input
                  id="bot-bubble"
                  value={cfg.appearance.bubbleText}
                  maxLength={BOT_LIMITS.bubbleText}
                  onChange={(e) => setAppearance({ bubbleText: e.target.value })}
                  className="border-border bg-muted text-foreground"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="bot-color" className="text-muted-foreground">{t('Main color')}</Label>
                <div className="flex items-center gap-2">
                  <input
                    id="bot-color"
                    type="color"
                    value={cfg.appearance.color}
                    onChange={(e) => setAppearance({ color: e.target.value })}
                    className="h-9 w-12 cursor-pointer rounded-md border border-border bg-muted p-1"
                  />
                  <span className="font-mono text-xs text-muted-foreground" data-no-translate>{cfg.appearance.color}</span>
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="bot-side" className="text-muted-foreground">{t('Side of the screen')}</Label>
                <select
                  id="bot-side"
                  value={cfg.appearance.side}
                  onChange={(e) => setAppearance({ side: e.target.value === 'left' ? 'left' : 'right' })}
                  className={SELECT_CLASS}
                >
                  <option value="right">{t('Right side')}</option>
                  <option value="left">{t('Left side')}</option>
                </select>
              </div>
            </fieldset>

            {/* greeting + questions */}
            <div className="space-y-3">
              <div className="grid gap-2">
                <Label htmlFor="bot-greeting" className="text-muted-foreground">{t('First message of the bot')}</Label>
                <Textarea
                  id="bot-greeting"
                  value={cfg.greeting}
                  maxLength={BOT_LIMITS.greeting}
                  onChange={(e) => set('greeting', e.target.value)}
                  className="min-h-16 border-border bg-muted text-foreground"
                />
              </div>

              <div>
                <p className="text-sm font-medium text-foreground">{t('Bot questions')}</p>
                <p className="text-xs text-muted-foreground">
                  {t('Name and WhatsApp are always asked. Use the arrows to change the order.')}
                </p>
              </div>
              <ol className="space-y-3">
                {cfg.questions.map((q, i) => {
                  const fixed = q.type === 'name' || q.type === 'phone';
                  const hasEmail = cfg.questions.some((x, j) => j !== i && x.type === 'email');
                  return (
                    <li key={q.id} className="space-y-3 rounded-lg border border-border p-3">
                      <div className="flex items-start gap-2">
                        <span className="mt-2 w-5 text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                        <Input
                          value={q.text}
                          maxLength={BOT_LIMITS.question}
                          onChange={(e) => setQuestion(i, { text: e.target.value })}
                          aria-label={t('Question text')}
                          placeholder={t('Write the question')}
                          className="border-border bg-muted text-foreground"
                        />
                        <div className="flex shrink-0 gap-1">
                          <button
                            type="button"
                            onClick={() => move(i, -1)}
                            disabled={i === 0}
                            aria-label={t('Move question up')}
                            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-30"
                          >
                            <ArrowUp className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => move(i, 1)}
                            disabled={i === cfg.questions.length - 1}
                            aria-label={t('Move question down')}
                            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-30"
                          >
                            <ArrowDown className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => set('questions', cfg.questions.filter((_, j) => j !== i))}
                            disabled={fixed}
                            aria-label={t('Remove question')}
                            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-30"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                      </div>

                      <div className="grid gap-3 sm:grid-cols-3">
                        <div className="grid gap-1.5">
                          <Label className="text-xs text-muted-foreground">{t('Type of answer')}</Label>
                          {q.type === 'name' ? (
                            <p className="py-1.5 text-sm text-foreground">{t("Visitor's name")}</p>
                          ) : q.type === 'phone' ? (
                            <p className="py-1.5 text-sm text-foreground">{t("Visitor's WhatsApp")}</p>
                          ) : (
                            <select
                              value={q.type}
                              onChange={(e) => changeType(i, e.target.value as BotQuestionType)}
                              className={SELECT_CLASS}
                              aria-label={t('Type of answer')}
                            >
                              <option value="text">{t('Free text')}</option>
                              <option value="choice">{t('Buttons to choose from')}</option>
                              <option value="email" disabled={hasEmail}>{t('Email address')}</option>
                            </select>
                          )}
                        </div>

                        <div className="grid gap-1.5 sm:col-span-2">
                          <Label className="text-xs text-muted-foreground">{t('Where the answer is saved')}</Label>
                          {q.type === 'name' ? (
                            <p className="py-1.5 text-sm text-foreground">{t('Contact name')}</p>
                          ) : q.type === 'phone' ? (
                            <p className="py-1.5 text-sm text-foreground">{t('Contact phone')}</p>
                          ) : q.type === 'email' ? (
                            <p className="py-1.5 text-sm text-foreground">{t('Contact email')}</p>
                          ) : (
                            <div className="flex gap-2">
                              <select
                                value={q.target === 'custom' ? 'custom' : 'note'}
                                onChange={(e) =>
                                  setQuestion(i, {
                                    target: e.target.value === 'custom' ? 'custom' : 'note',
                                    customFieldId: undefined,
                                  })
                                }
                                className={SELECT_CLASS}
                                aria-label={t('Where the answer is saved')}
                              >
                                <option value="note">{t('Only in the deal note')}</option>
                                <option value="custom" disabled={resources.customFields.length === 0}>
                                  {t('A custom contact field')}
                                </option>
                              </select>
                              {q.target === 'custom' ? (
                                <select
                                  value={q.customFieldId ?? ''}
                                  onChange={(e) => setQuestion(i, { customFieldId: e.target.value || undefined })}
                                  className={SELECT_CLASS}
                                  aria-label={t('Custom contact field')}
                                >
                                  <option value="">{t('Pick a field')}</option>
                                  {resources.customFields.map((cf) => (
                                    <option
                                      key={cf.id}
                                      value={cf.id}
                                      disabled={cfg.questions.some((x, j) => j !== i && x.customFieldId === cf.id)}
                                    >
                                      {cf.field_name}
                                    </option>
                                  ))}
                                </select>
                              ) : null}
                            </div>
                          )}
                        </div>
                      </div>

                      {q.type === 'choice' ? (
                        <div className="grid gap-1.5">
                          <Label className="text-xs text-muted-foreground">
                            {t('Answer buttons, one per line (2 to 6)')}
                          </Label>
                          <Textarea
                            value={(q.options ?? []).join('\n')}
                            onChange={(e) =>
                              setQuestion(i, { options: e.target.value.split('\n').slice(0, BOT_LIMITS.maxOptions) })
                            }
                            aria-label={t('Answer buttons, one per line (2 to 6)')}
                            className="min-h-16 border-border bg-muted text-foreground"
                          />
                          {(q.options ?? []).length < BOT_LIMITS.minOptions ? (
                            <p className="text-xs text-amber-600">{t('Add at least 2 answer buttons.')}</p>
                          ) : null}
                        </div>
                      ) : null}

                      <label className={cn('flex items-center gap-2 text-sm', fixed ? 'text-muted-foreground' : 'text-foreground')}>
                        <input
                          type="checkbox"
                          checked={fixed ? true : q.required}
                          disabled={fixed}
                          onChange={(e) => setQuestion(i, { required: e.target.checked })}
                          className="size-4"
                        />
                        {fixed ? t('Always required') : t('Required answer')}
                      </label>
                    </li>
                  );
                })}
              </ol>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addQuestion}
                disabled={cfg.questions.length >= BOT_LIMITS.maxQuestions}
                className="border-border bg-transparent text-muted-foreground hover:bg-muted"
              >
                <Plus className="size-3.5" />
                {t('Add question')}
              </Button>
              {cfg.questions.length >= BOT_LIMITS.maxQuestions ? (
                <p className="text-xs text-muted-foreground">{t('You reached the limit of 10 questions.')}</p>
              ) : null}
            </div>

            {/* destination */}
            <fieldset className="space-y-3">
              <legend className="mb-1 text-sm font-medium text-foreground">{t('Where the lead goes')}</legend>
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
                      <option key={p.id} value={p.id}>{p.name}</option>
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
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-2">
                  <Label className="text-muted-foreground">{t('Assignee')}</Label>
                  <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className={SELECT_CLASS}>
                    <option value="">{t('No assignee')}</option>
                    {resources.members.map((m) => (
                      <option key={m.user_id} value={m.user_id}>{m.full_name || m.email || m.user_id}</option>
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
                            onClick={() => setTagIds((prev) => (on ? prev.filter((id) => id !== tag.id) : [...prev, tag.id]))}
                            aria-pressed={on}
                            className={cn(
                              'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
                              on ? 'border-primary bg-primary-soft text-primary' : 'border-border text-muted-foreground hover:bg-muted',
                            )}
                          >
                            <span className="size-2 rounded-full" style={{ backgroundColor: tag.color }} aria-hidden />
                            <span data-no-translate>{tag.name}</span>
                            {on ? checkedMark : null}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </fieldset>

            {/* end of the conversation */}
            <fieldset className="space-y-3">
              <legend className="mb-1 text-sm font-medium text-foreground">{t('End of the conversation')}</legend>
              <div className="grid gap-2">
                <Label htmlFor="bot-thanks" className="text-muted-foreground">{t('Thank you message')}</Label>
                <Textarea
                  id="bot-thanks"
                  value={cfg.end.thanks}
                  maxLength={BOT_LIMITS.thanks}
                  onChange={(e) => setEnd({ thanks: e.target.value })}
                  className="min-h-16 border-border bg-muted text-foreground"
                />
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={cfg.end.whatsappEnabled}
                  onCheckedChange={(on) => setEnd({ whatsappEnabled: on })}
                  aria-label={t('Show the Continue on WhatsApp button')}
                />
                <span className="text-sm text-foreground">{t('Show the Continue on WhatsApp button')}</span>
              </div>
              {cfg.end.whatsappEnabled ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <Label htmlFor="bot-number" className="text-muted-foreground">{t('WhatsApp number of the company')}</Label>
                    <select
                      id="bot-number"
                      value={numberChoice}
                      onChange={(e) => setEnd({ whatsappNumber: e.target.value === OTHER_NUMBER ? ' ' : e.target.value })}
                      className={SELECT_CLASS}
                    >
                      <option value="">{t('Choose a number')}</option>
                      {numbers.map((n) => (
                        <option key={n.digits} value={n.digits}>{n.label}</option>
                      ))}
                      <option value={OTHER_NUMBER}>{t('Another number')}</option>
                    </select>
                    {numberChoice === OTHER_NUMBER ? (
                      <Input
                        value={cfg.end.whatsappNumber.trim()}
                        onChange={(e) => setEnd({ whatsappNumber: e.target.value.replace(/\D/g, '') || ' ' })}
                        inputMode="tel"
                        placeholder="5511999990000"
                        aria-label={t('WhatsApp number of the company')}
                        className="border-border bg-muted font-mono text-foreground"
                      />
                    ) : null}
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="bot-template" className="text-muted-foreground">{t('Ready message (use {nome} for the name)')}</Label>
                    <Input
                      id="bot-template"
                      value={cfg.end.messageTemplate}
                      maxLength={BOT_LIMITS.messageTemplate}
                      onChange={(e) => setEnd({ messageTemplate: e.target.value })}
                      className="border-border bg-muted text-foreground"
                    />
                  </div>
                </div>
              ) : null}
            </fieldset>

            {/* LGPD */}
            <fieldset className="space-y-3">
              <legend className="mb-1 text-sm font-medium text-foreground">{t('Privacy (LGPD)')}</legend>
              <div className="grid gap-2">
                <Label htmlFor="bot-consent" className="text-muted-foreground">{t('Consent text the visitor accepts')}</Label>
                <Textarea
                  id="bot-consent"
                  value={cfg.lgpd.text}
                  maxLength={BOT_LIMITS.lgpdText}
                  onChange={(e) => set('lgpd', { ...cfg.lgpd, text: e.target.value })}
                  className="min-h-16 border-border bg-muted text-foreground"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="bot-privacy" className="text-muted-foreground">{t('Privacy policy link (optional)')}</Label>
                <Input
                  id="bot-privacy"
                  value={cfg.lgpd.linkUrl}
                  maxLength={BOT_LIMITS.url}
                  onChange={(e) => set('lgpd', { ...cfg.lgpd, linkUrl: e.target.value })}
                  placeholder="https://minhaloja.com.br/privacidade"
                  className="border-border bg-muted text-foreground"
                />
              </div>
            </fieldset>

            {/* domains */}
            <div className="grid gap-2">
              <Label htmlFor="bot-domains" className="text-muted-foreground">{t('Sites where the bot may run')}</Label>
              <Textarea
                id="bot-domains"
                value={domainsText}
                onChange={(e) => setDomainsText(e.target.value)}
                placeholder="minhaloja.com.br"
                className="min-h-16 border-border bg-muted font-mono text-foreground"
              />
              <p className="text-xs text-muted-foreground">
                {t('One address per line. The www version works too. Requests from other sites are refused, and with no address the bot only runs in this preview.')}
              </p>
            </div>

            {submitted && issues.length > 0 ? (
              <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                <p className="font-medium">{t('Fix these points to save:')}</p>
                <ul className="mt-1 list-disc pl-5">
                  {issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </div>
            ) : null}

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

          <aside className="space-y-2 lg:sticky lg:top-0 lg:self-start">
            <p className="text-sm font-medium text-foreground">{t('Live preview')}</p>
            <p className="text-xs text-muted-foreground">{t('This is how visitors see the bot. Nothing you type here is sent or saved.')}</p>
            <SiteBotPreview config={config} />
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}
