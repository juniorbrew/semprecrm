'use client';

import { useEffect, useMemo, useState } from 'react';
import { Bot, Check, ChevronDown, ChevronRight, Copy, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { useLanguage } from '@/hooks/use-language';
import { listLeadSourceEvents } from '@/lib/lead-capture/client';
import { resolveSiteUrl } from '@/lib/lead-capture/webhook-url';
import { createClient } from '@/lib/supabase/client';
import { eventAnswerLines, validateBotConfig } from '@/lib/site-bot';
import { formatRelative } from '@/lib/automations/trigger-meta';
import type { LeadSource, LeadSourceEvent } from '@/types';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

import { SettingsChip } from './settings-chip';
import { SettingsGroup } from './settings-group';

/** The one line the customer pastes into their website. */
export function botSnippet(publicKey: string, siteUrl: string = resolveSiteUrl()): string {
  return `<script src="${siteUrl}/robo.js" data-robo="${publicKey}" async></script>`;
}

const ICON_BTN =
  'flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none';

/** Configurações → Integrações: the website bots, next to the webhook sources. */
export function SiteBotsGroup({
  bots,
  loading,
  selectedId,
  onSelect,
  onCreate,
  onEdit,
  onDelete,
  onToggle,
}: {
  bots: LeadSource[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: () => void;
  onEdit: (bot: LeadSource) => void;
  onDelete: (bot: LeadSource) => void;
  onToggle: (bot: LeadSource, active: boolean) => void;
}) {
  const { t, language } = useLanguage();
  const [copied, setCopied] = useState(false);
  const selected = bots.find((b) => b.id === selectedId) ?? null;
  const domains = selected?.bot_config?.domains;
  const noDomains = !Array.isArray(domains) || domains.length === 0;

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t('Could not copy. Select the code and copy it by hand.'));
    }
  }

  return (
    <SettingsGroup
      title={t('Site bots')}
      description={t('A chat bubble for your website. It asks your questions and creates the lead in the pipeline.')}
      action={
        <Button variant="outline" size="sm" onClick={onCreate}>
          <Plus className="size-3.5" />
          {t('New site bot')}
        </Button>
      }
    >
      {loading ? (
        <div className="h-12 animate-pulse rounded-lg bg-muted/60" />
      ) : bots.length === 0 ? (
        <div className="py-6 text-center">
          <Bot className="mx-auto size-5 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium text-foreground">{t('No site bots yet')}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('Create a bot, copy one line of code and paste it into your website.')}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-normal">{t('Name')}</th>
                <th className="px-3 py-2 font-normal">{t('Active')}</th>
                <th className="px-3 py-2 text-right font-normal">{t('Received')}</th>
                <th className="hidden px-3 py-2 font-normal md:table-cell">{t('Last received')}</th>
                <th className="w-24 px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border border-t border-border">
              {bots.map((bot) => {
                const isSelected = bot.id === selectedId;
                return (
                  <tr
                    key={bot.id}
                    className={cn(
                      'cursor-pointer align-middle transition-colors duration-150 hover:bg-muted/50 motion-reduce:transition-none',
                      isSelected && 'bg-primary/10 shadow-[inset_3px_0_0_var(--primary)] hover:bg-primary/10',
                    )}
                    onClick={() => onSelect(isSelected ? null : bot.id)}
                    aria-selected={isSelected}
                  >
                    <td className="px-3 py-2.5 font-medium text-foreground">
                      <span className="flex items-center gap-1.5">
                        {isSelected ? (
                          <ChevronDown className="size-3.5 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="size-3.5 text-muted-foreground" />
                        )}
                        <span data-no-translate>{bot.name}</span>
                        <SettingsChip variant="muted">{t('Site bot')}</SettingsChip>
                      </span>
                    </td>
                    <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <Switch
                        checked={bot.is_active}
                        onCheckedChange={(checked) => onToggle(bot, checked)}
                        aria-label={bot.is_active ? t('Active') : t('Paused source')}
                      />
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-foreground">{bot.received_count}</td>
                    <td className="hidden px-3 py-2.5 text-muted-foreground md:table-cell">
                      {formatRelative(bot.last_received_at, language)}
                    </td>
                    <td className="px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => onEdit(bot)}
                          aria-label={t('Edit')}
                          title={t('Edit')}
                          className={cn(ICON_BTN, 'hover:bg-muted hover:text-foreground')}
                        >
                          <Pencil className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDelete(bot)}
                          aria-label={t('Delete')}
                          title={t('Delete')}
                          className={cn(ICON_BTN, 'hover:bg-destructive/10 hover:text-destructive')}
                        >
                          <Trash2 className="size-3.5" />
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

      {selected?.public_key ? (
        <div className="space-y-3 rounded-lg border border-border p-4">
          <div>
            <p className="text-sm font-medium text-foreground">{t('Code to paste into your website')}</p>
            <p className="text-xs text-muted-foreground">
              {t('The key in this code is public. It only lets visitors talk to this bot, and only from the sites you allowed.')}
            </p>
          </div>
          <div className="flex items-start gap-2">
            <pre
              data-no-translate
              className="min-w-0 flex-1 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs text-foreground"
            >
              {botSnippet(selected.public_key)}
            </pre>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copy(botSnippet(selected.public_key!))}
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? t('Copied') : t('Copy code')}
            </Button>
          </div>
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            <li>
              {t('WordPress: open Appearance, then Theme file editor (or a plugin like Insert Headers and Footers) and paste the code before the closing body tag.')}
            </li>
            <li>
              {t('Wix: open Settings, then Custom code, add the code, choose Body end and apply it to all pages.')}
            </li>
            <li>
              {t('Other sites: paste the code before the closing body tag of each page, or in the footer scripts area of your site builder.')}
            </li>
          </ul>
          <BotEvents key={selected.id} bot={selected} />
          {noDomains ? (
            <p role="note" className="text-xs text-amber-600">
              {t('No site is allowed yet, so the bot only works in the preview. Edit the bot and add your website address.')}
            </p>
          ) : null}
        </div>
      ) : null}
    </SettingsGroup>
  );
}

const EVENT_LABEL: Record<LeadSourceEvent['status'], string> = {
  ok: 'Contact created',
  duplicate: 'Existing contact',
  error: 'Error',
};

/**
 * Latest submissions of a bot, with the visitor's answers as plain text. The
 * deal note only exists for a NEW deal, so this is where a returning
 * contact's answers can always be read.
 */
function BotEvents({ bot }: { bot: LeadSource }) {
  const { t, language } = useLanguage();
  const supabase = useMemo(() => createClient(), []);
  const [events, setEvents] = useState<LeadSourceEvent[] | null>(null);
  const parsed = validateBotConfig(bot.bot_config);

  useEffect(() => {
    let cancelled = false;
    void listLeadSourceEvents(supabase, bot.id, 20)
      .then((rows) => !cancelled && setEvents(rows))
      .catch(() => !cancelled && setEvents([]));
    return () => {
      cancelled = true;
    };
  }, [bot.id, supabase]);

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-foreground">{t('Latest conversations')}</p>
      {events === null ? (
        <div className="h-10 animate-pulse rounded-lg bg-muted/60" />
      ) : events.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('No conversations received yet.')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {events.map((ev) => {
            const lines = parsed.ok ? eventAnswerLines(parsed.config, ev.payload) : [];
            return (
              <li key={ev.id} className="space-y-1 px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <SettingsChip variant={ev.status === 'ok' ? 'ok' : ev.status === 'duplicate' ? 'warn' : 'bad'}>
                    {t(EVENT_LABEL[ev.status] ?? 'Error')}
                  </SettingsChip>
                  <span className="text-xs text-muted-foreground">{formatRelative(ev.created_at, language)}</span>
                </div>
                {lines.length > 0 ? (
                  <p data-no-translate className="whitespace-pre-wrap break-words text-xs text-foreground">
                    {lines.join(String.fromCharCode(10))}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
