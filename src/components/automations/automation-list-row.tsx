'use client';

import { AlertTriangle, Copy, FileText, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import type { Automation } from '@/types';
import type { Language } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { triggerMeta, formatRelative } from '@/lib/automations/trigger-meta';
import { frequencyLabel } from '@/lib/automations/frequency';

/** Row density of the automations list, per user on this device. */
export type AutomationsDensity = 'comfortable' | 'compact';
const DENSITY_KEY_PREFIX = 'sempre:automations:density:';

export function readAutomationsDensity(userId: string): AutomationsDensity {
  try {
    return localStorage.getItem(DENSITY_KEY_PREFIX + userId) === 'compact' ? 'compact' : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

export function writeAutomationsDensity(userId: string, density: AutomationsDensity): void {
  try {
    localStorage.setItem(DENSITY_KEY_PREFIX + userId, density);
  } catch {
    // Persistence is best-effort.
  }
}

export const AUTOMATIONS_COPY = {
  'pt-BR': {
    title: 'Automações',
    newAutomation: 'Nova automação',
    templates: 'Começar por um modelo',
    compact: 'Lista compacta',
    empty: 'Nenhuma automação ainda.',
    emptyHint: 'Escolha um modelo acima ou comece do zero.',
    loadError: 'Não foi possível carregar as automações.',
    retry: 'Tentar de novo',
    active: 'Ativa',
    paused: 'Pausada',
    runs: (n: number) => (n === 1 ? '1 execução' : `${n} execuções`),
    lastRun: (when: string) => `última ${when}`,
    activate: (name: string) => `Ativar ${name}`,
    deactivate: (name: string) => `Pausar ${name}`,
    more: (name: string) => `Mais ações para ${name}`,
    edit: 'Editar',
    duplicate: 'Duplicar',
    logs: 'Ver execuções',
    delete: 'Excluir',
    duplicateTrigger: (names: string) =>
      `Mesmo gatilho que ${names} — o cliente pode receber tudo em dobro.`,
  },
  'en-US': {
    title: 'Automations',
    newAutomation: 'New automation',
    templates: 'Start from a template',
    compact: 'Compact list',
    empty: 'No automations yet.',
    emptyHint: 'Pick a template above or start from scratch.',
    loadError: 'Could not load automations.',
    retry: 'Try again',
    active: 'Active',
    paused: 'Paused',
    runs: (n: number) => (n === 1 ? '1 run' : `${n} runs`),
    lastRun: (when: string) => `last ${when}`,
    activate: (name: string) => `Activate ${name}`,
    deactivate: (name: string) => `Pause ${name}`,
    more: (name: string) => `More actions for ${name}`,
    edit: 'Edit',
    duplicate: 'Duplicate',
    logs: 'View runs',
    delete: 'Delete',
    duplicateTrigger: (names: string) =>
      `Same trigger as ${names} — customers may get every reply twice.`,
  },
} satisfies Record<Language, Record<string, unknown>>;

export type AutomationsCopy = (typeof AUTOMATIONS_COPY)['pt-BR'];

/** "Trigger · frequency · N runs · last X" — the one meta line under the name. */
export function automationMetaLine(
  a: Pick<Automation, 'trigger_type' | 'run_frequency' | 'cooldown_hours' | 'execution_count' | 'last_executed_at'>,
  language: Language,
  copy: AutomationsCopy,
): string {
  return [
    triggerMeta(a.trigger_type, language).label,
    frequencyLabel(a.run_frequency ?? 'every_time', language).replace('X', String(a.cooldown_hours ?? 24)),
    copy.runs(a.execution_count ?? 0),
    copy.lastRun(formatRelative(a.last_executed_at, language)),
  ].join(' · ');
}

const quickBtn =
  'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

export interface AutomationListRowProps {
  automation: Automation;
  language: Language;
  copy: AutomationsCopy;
  compact: boolean;
  /** Names of other active automations on the same trigger. */
  duplicateOf: string[];
  onToggle: (next: boolean) => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onLogs: () => void;
  onDelete: () => void;
}

/**
 * One automation: name, one quiet meta line, status dot + text, toggle.
 * Quick actions (edit, runs) appear on hover / focus-within and are hidden
 * from the a11y tree: the "…" menu holds the same actions with labels.
 */
export function AutomationListRow({
  automation,
  language,
  copy,
  compact,
  duplicateOf,
  onToggle,
  onEdit,
  onDuplicate,
  onLogs,
  onDelete,
}: AutomationListRowProps) {
  const active = automation.is_active;
  const meta = automationMetaLine(automation, language, copy);
  return (
    <li
      className={cn(
        'group/row flex items-center gap-3 px-3 transition-colors duration-150 hover:bg-muted/50 motion-reduce:transition-none',
        compact ? 'py-1.5' : 'py-3',
      )}
    >
      <button
        type="button"
        onClick={onEdit}
        className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className={cn('flex min-w-0', compact ? 'items-baseline gap-2' : 'flex-col')}>
          <span className="truncate text-sm font-medium text-foreground" data-no-translate>
            {automation.name}
          </span>
          <span className="min-w-0 truncate text-xs text-muted-foreground">{meta}</span>
        </span>
        {!compact && automation.description && (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground" data-no-translate>
            {automation.description}
          </span>
        )}
        {duplicateOf.length > 0 && (
          <span className="mt-1 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 size-3.5 flex-shrink-0" aria-hidden />
            <span>{copy.duplicateTrigger(duplicateOf.map((n) => `"${n}"`).join(', '))}</span>
          </span>
        )}
      </button>

      <span className="hidden w-20 shrink-0 items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex">
        <span
          aria-hidden
          className={cn('size-1.5 rounded-full', active ? 'bg-emerald-500' : 'bg-muted-foreground/50')}
        />
        {active ? copy.active : copy.paused}
      </span>

      <div className="flex shrink-0 items-center gap-0.5">
        <div
          aria-hidden
          className="hidden items-center gap-0.5 opacity-0 transition-opacity duration-150 group-focus-within/row:opacity-100 group-hover/row:opacity-100 motion-reduce:transition-none md:flex"
        >
          <button type="button" tabIndex={-1} title={copy.edit} onClick={onEdit} className={quickBtn}>
            <Pencil className="size-3.5" />
          </button>
          <button type="button" tabIndex={-1} title={copy.logs} onClick={onLogs} className={quickBtn}>
            <FileText className="size-3.5" />
          </button>
        </div>
        <Switch
          checked={active}
          onCheckedChange={(v) => onToggle(!!v)}
          aria-label={active ? copy.deactivate(automation.name) : copy.activate(automation.name)}
          className="mx-1.5"
        />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={copy.more(automation.name)}
                className="text-muted-foreground hover:text-foreground"
              />
            }
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>
              <Pencil className="size-4" />
              {copy.edit}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onDuplicate}>
              <Copy className="size-4" />
              {copy.duplicate}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onLogs}>
              <FileText className="size-4" />
              {copy.logs}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 className="size-4" />
              {copy.delete}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}
