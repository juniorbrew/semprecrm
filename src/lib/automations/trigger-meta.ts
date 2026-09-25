import type { AutomationTriggerType } from '@/types';
import type { Language } from '@/lib/i18n';

export interface TriggerMeta {
  label: string;
  /** Tailwind classes for the Badge pill on the list row. */
  pillClass: string;
}

export const TRIGGER_META: Record<AutomationTriggerType, TriggerMeta> = {
  new_message_received: {
    label: 'New Message',
    pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
  },
  first_inbound_message: {
    label: 'First Message from Contact',
    pillClass: 'border-teal-500/30 bg-teal-500/10 text-teal-300',
  },
  keyword_match: {
    label: 'Keyword Match',
    pillClass: 'border-purple-500/30 bg-purple-500/10 text-purple-300',
  },
  new_contact_created: {
    label: 'New Contact',
    pillClass: 'border-primary/30 bg-primary/10 text-primary',
  },
  conversation_assigned: {
    label: 'Conversation Assigned',
    pillClass: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
  },
  tag_added: {
    label: 'Tag Added',
    pillClass: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  },
  time_based: {
    label: 'Time-Based',
    pillClass: 'border-slate-500/30 bg-slate-500/10 text-muted-foreground',
  },
  lead_captured: {
    label: 'Lead Captured',
    pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  },
  conversation_inactive: {
    label: 'Conversation Inactive',
    pillClass: 'border-orange-500/30 bg-orange-500/10 text-orange-300',
  },
  conversation_reopened: {
    label: 'Conversation Reopened',
    pillClass: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  },
  conversation_resolved: {
    label: 'Conversation Resolved',
    pillClass: 'border-lime-500/30 bg-lime-500/10 text-lime-300',
  },
};

const PT_BR_TRIGGER_LABELS: Partial<Record<AutomationTriggerType, string>> = {
  new_message_received: 'Nova mensagem',
  first_inbound_message: 'Primeira mensagem do contato',
  keyword_match: 'Correspondência de palavra-chave',
  new_contact_created: 'Novo contato',
  conversation_assigned: 'Conversa atribuída',
  tag_added: 'Etiqueta adicionada',
  time_based: 'Baseado em horário',
  lead_captured: 'Lead capturado',
  conversation_inactive: 'Conversa sem resposta',
  conversation_reopened: 'Conversa reaberta (novo atendimento)',
  conversation_resolved: 'Conversa resolvida',
};

export function triggerMeta(
  t: AutomationTriggerType | string,
  language: Language = 'en-US'
): TriggerMeta {
  const meta = TRIGGER_META[t as AutomationTriggerType] ?? {
    label: t,
    pillClass: 'border-slate-500/30 bg-slate-500/10 text-muted-foreground',
  };
  return language === 'pt-BR'
    ? {
        ...meta,
        label: PT_BR_TRIGGER_LABELS[t as AutomationTriggerType] ?? meta.label,
      }
    : meta;
}

export function formatRelative(
  iso: string | null | undefined,
  language: Language = 'en-US'
): string {
  const pt = language === 'pt-BR';
  if (!iso) return pt ? 'nunca' : 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return pt ? 'nunca' : 'never';
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 60) return pt ? 'agora' : 'just now';
  if (diffSec < 3600)
    return pt
      ? `há ${Math.floor(diffSec / 60)} min`
      : `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400)
    return pt
      ? `há ${Math.floor(diffSec / 3600)} h`
      : `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 2_592_000)
    return pt
      ? `há ${Math.floor(diffSec / 86400)} d`
      : `${Math.floor(diffSec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(language);
}
