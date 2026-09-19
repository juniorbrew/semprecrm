'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Check,
  Loader2,
  Minus,
  X,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import type {
  Automation,
  AutomationLog,
  AutomationLogStepResult,
} from '@/types';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatRelative, triggerMeta } from '@/lib/automations/trigger-meta';
import { useLanguage } from '@/hooks/use-language';

export default function AutomationLogsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { language, t } = useLanguage();

  const [automation, setAutomation] = useState<Automation | null>(null);
  const [logs, setLogs] = useState<AutomationLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openLogId, setOpenLogId] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const supabase = createClient();
        const [autRes, logRes] = await Promise.all([
          supabase.from('automations').select('*').eq('id', id).maybeSingle(),
          supabase
            .from('automation_logs')
            .select('*, contact:contacts(id, name, phone)')
            .eq('automation_id', id)
            .order('created_at', { ascending: false })
            .limit(100),
        ]);
        if (autRes.error) throw autRes.error;
        if (logRes.error) throw logRes.error;
        setAutomation(autRes.data as Automation | null);
        setLogs((logRes.data ?? []) as AutomationLog[]);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('Failed to load logs'));
      }
    }
    load();
  }, [id, t]);

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3">
        <p className="text-sm text-red-400">{error}</p>
        <Button variant="outline" onClick={() => router.push('/automations')}>
          {t('Back')}
        </Button>
      </div>
    );
  }

  if (!automation || logs === null) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => router.push('/automations')}
          className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-8 w-8 items-center justify-center rounded-md transition-colors"
          aria-label={t('Back')}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div>
          <h1 className="text-foreground text-2xl font-bold">
            {automation.name}
          </h1>
          <p className="text-muted-foreground mt-0.5 text-sm">
            {t('Execution logs')}
          </p>
        </div>
      </div>

      {logs.length === 0 ? (
        <div className="border-border bg-card/40 flex h-48 flex-col items-center justify-center rounded-xl border border-dashed">
          <p className="text-foreground text-sm">
            {t('No executions yet')}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            {t('Trigger this automation to see runs here.')}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {logs.map((log) => {
            const isOpen = openLogId === log.id;
            return (
              <li
                key={log.id}
                className="border-border bg-card rounded-xl border"
              >
                <button
                  type="button"
                  onClick={() => setOpenLogId(isOpen ? null : log.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left"
                >
                  {isOpen ? (
                    <ChevronDown className="text-muted-foreground h-4 w-4" />
                  ) : (
                    <ChevronRight className="text-muted-foreground h-4 w-4" />
                  )}
                  <StatusBadge status={log.status} language={language} />
                  <div className="min-w-0 flex-1">
                    <div className="text-foreground truncate text-sm font-medium">
                      {log.contact?.name ??
                        log.contact?.phone ??
                        t('Unknown contact')}
                    </div>
                    <div className="text-muted-foreground truncate text-xs">
                      {triggerMeta(log.trigger_event, language).label} ·{' '}
                      {log.steps_executed?.length ?? 0}{' '}
                      {t(log.steps_executed?.length === 1 ? 'step' : 'steps')}
                    </div>
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {formatRelative(log.created_at, language)}
                  </div>
                </button>
                {isOpen && (
                  <div className="border-border border-t px-4 py-3">
                    {log.error_message && (
                      <p className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                        {log.error_message}
                      </p>
                    )}
                    <ul className="space-y-1.5">
                      {(log.steps_executed ?? []).map((r, i) => (
                        <StepRow key={i} result={r} language={language} />
                      ))}
                      {(log.steps_executed ?? []).length === 0 && (
                        <li className="text-muted-foreground text-xs">
                          {t('No steps recorded.')}
                        </li>
                      )}
                    </ul>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

type Lang = import('@/lib/i18n').Language;

const RUN_STATUS_LABEL: Record<Lang, Record<AutomationLog['status'], string>> = {
  'pt-BR': { success: 'sucesso', partial: 'parcial', failed: 'falhou' },
  'en-US': { success: 'success', partial: 'partial', failed: 'failed' },
};

function StatusBadge({
  status,
  language,
}: {
  status: AutomationLog['status'];
  language: Lang;
}) {
  const classes =
    status === 'success'
      ? 'border-primary/30 bg-primary/10 text-primary'
      : status === 'partial'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
        : 'border-red-500/30 bg-red-500/10 text-red-300';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
        classes
      )}
    >
      {RUN_STATUS_LABEL[language][status] ?? status}
    </span>
  );
}

/** Step type codes (`send_message`, …) as they read in each language. */
const STEP_TYPE_LABEL: Record<Lang, Record<string, string>> = {
  'pt-BR': {
    send_message: 'enviar mensagem',
    send_template: 'enviar modelo',
    add_tag: 'adicionar etiqueta',
    remove_tag: 'remover etiqueta',
    assign_conversation: 'atribuir conversa',
    update_contact_field: 'atualizar campo do contato',
    create_deal: 'criar negócio',
    wait: 'aguardar',
    condition: 'condição',
    send_webhook: 'enviar webhook',
    close_conversation: 'resolver conversa',
    create_task: 'criar tarefa',
  },
  'en-US': {
    send_message: 'send message',
    send_template: 'send template',
    add_tag: 'add tag',
    remove_tag: 'remove tag',
    assign_conversation: 'assign conversation',
    update_contact_field: 'update contact field',
    create_deal: 'create deal',
    wait: 'wait',
    condition: 'condition',
    send_webhook: 'send webhook',
    close_conversation: 'resolve conversation',
    create_task: 'create task',
  },
};

const WAIT_UNIT_LABEL: Record<string, { pt: [string, string]; en: [string, string] }> = {
  minutes: { pt: ['minuto', 'minutos'], en: ['minute', 'minutes'] },
  hours: { pt: ['hora', 'horas'], en: ['hour', 'hours'] },
  days: { pt: ['dia', 'dias'], en: ['day', 'days'] },
};

const CONTACT_FIELD_LABEL: Record<string, { pt: string; en: string }> = {
  name: { pt: 'nome', en: 'name' },
  email: { pt: 'e-mail', en: 'email' },
  phone: { pt: 'telefone', en: 'phone' },
  company: { pt: 'empresa', en: 'company' },
};

/**
 * The engine (src/lib/automations/engine.ts) records a short English
 * `detail` per step — "waiting 2 hours", "tag <uuid> added",
 * "assigned to <uuid>" — with ids that mean nothing to a person. This
 * rewrites every known shape into plain copy for the active language
 * and drops the ids; unknown text falls back to the dictionary (engine
 * error messages are keyed there) and then to itself.
 */
function describeStepDetail(
  detail: string,
  language: Lang,
  t: (english: string) => string
): string {
  const pt = language === 'pt-BR';
  let m: RegExpMatchArray | null;

  if ((m = detail.match(/^waiting (\d+(?:\.\d+)?) (minutes|hours|days)$/))) {
    const n = Number(m[1]);
    const unit = WAIT_UNIT_LABEL[m[2]];
    const label = pt ? unit.pt : unit.en;
    return `${pt ? 'aguardando' : 'waiting'} ${m[1]} ${n === 1 ? label[0] : label[1]}`;
  }
  if ((m = detail.match(/^branch=(yes|no)$/))) {
    const yes = m[1] === 'yes';
    return pt ? `ramo: ${yes ? 'sim' : 'não'}` : `branch: ${yes ? 'yes' : 'no'}`;
  }
  if (/^sent via Meta/.test(detail)) return pt ? 'mensagem enviada via Meta' : 'message sent via Meta';
  if (/^template sent via Meta/.test(detail)) return pt ? 'modelo enviado via Meta' : 'template sent via Meta';
  if (/^tag \S+ added$/.test(detail)) return pt ? 'etiqueta adicionada' : 'tag added';
  if (/^tag \S+ removed$/.test(detail)) return pt ? 'etiqueta removida' : 'tag removed';
  if (detail === 'no agent resolved') return pt ? 'nenhum responsável disponível' : 'no assignee available';
  if (/^assigned to \S+$/.test(detail)) return pt ? 'conversa atribuída' : 'conversation assigned';
  if ((m = detail.match(/^field (\S+) not writable from automations$/))) {
    const field = CONTACT_FIELD_LABEL[m[1]];
    const name = field ? (pt ? field.pt : field.en) : m[1];
    return pt
      ? `o campo ${name} não pode ser alterado por automações`
      : `field ${name} cannot be changed by automations`;
  }
  if (detail === 'custom field updated') return pt ? 'campo personalizado atualizado' : 'custom field updated';
  if ((m = detail.match(/^(\S+) updated$/))) {
    const field = CONTACT_FIELD_LABEL[m[1]];
    const name = field ? (pt ? field.pt : field.en) : m[1];
    return pt ? `campo ${name} atualizado` : `field ${name} updated`;
  }
  if (detail === 'deal created') return pt ? 'negócio criado' : 'deal created';
  if ((m = detail.match(/^webhook (\d{3})$/))) {
    return pt ? `webhook respondeu ${m[1]}` : `webhook answered ${m[1]}`;
  }
  if (detail === 'conversation closed') return pt ? 'conversa resolvida' : 'conversation resolved';
  if (/^task created/.test(detail)) return pt ? 'tarefa criada' : 'task created';
  if (/^unknown step:/.test(detail)) return pt ? 'etapa desconhecida' : 'unknown step';
  if (detail === 'contato descadastrado') return pt ? 'contato descadastrado' : 'contact opted out';
  return t(detail);
}

function StepRow({
  result,
  language,
}: {
  result: AutomationLogStepResult;
  language: Lang;
}) {
  const { t } = useLanguage();
  const ok = result.status === 'success';
  const skipped = result.status === 'skipped';
  return (
    <li className="flex items-start gap-2 text-xs">
      <span
        className={cn(
          'mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full',
          ok
            ? 'bg-primary/20 text-primary'
            : skipped
              ? 'bg-muted text-muted-foreground'
              : 'bg-red-500/20 text-red-400'
        )}
        aria-hidden
      >
        {ok ? <Check className="h-3 w-3" /> : skipped ? <Minus className="h-3 w-3" /> : <X className="h-3 w-3" />}
      </span>
      <span className="text-muted-foreground">
        {STEP_TYPE_LABEL[language][result.step_type] ?? result.step_type}
      </span>
      {result.detail && (
        <span className="text-muted-foreground truncate">
          — {describeStepDetail(result.detail, language, t)}
        </span>
      )}
    </li>
  );
}
