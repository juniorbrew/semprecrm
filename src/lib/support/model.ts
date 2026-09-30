// ============================================================
// Support triage vocabulary (migration 071): priorities, sentiments,
// resolution outcomes, the category colour palette, and the
// language-keyed copy the support UI shares. Pure — no I/O.
// ============================================================

import type {
  ConversationPriority,
  ConversationResolution,
  ConversationSentiment,
} from '@/types'
import type { Language } from '@/lib/i18n'

export const PRIORITIES: readonly ConversationPriority[] = ['low', 'normal', 'high', 'urgent']
export const SENTIMENTS: readonly ConversationSentiment[] = ['negative', 'neutral', 'positive']
export const RESOLUTIONS: readonly ConversationResolution[] = [
  'resolved',
  'not_applicable',
  'closed_by_customer',
  'expired',
  'duplicate',
]
/** One click on "Resolver" records this. */
export const DEFAULT_RESOLUTION: ConversationResolution = 'resolved'

/** "Resolver como…" offers the outcomes besides the default (the main button). */
export const RESOLVE_AS_OPTIONS: readonly ConversationResolution[] = RESOLUTIONS.filter((r) => r !== DEFAULT_RESOLUTION)

/** Outcome to show next to "Resolvida": only when it says more than "resolved". */
export function resolutionNote(
  status: string,
  resolution: ConversationResolution | null | undefined,
): ConversationResolution | null {
  return status === 'closed' && resolution && resolution !== DEFAULT_RESOLUTION ? resolution : null
}

export const CATEGORY_COLORS = [
  'gray',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
] as const
export type CategoryColor = (typeof CATEGORY_COLORS)[number]

/** Full class names (Tailwind scans source for them) for a 6 px dot. */
export const CATEGORY_DOT: Record<CategoryColor, string> = {
  gray: 'bg-zinc-400',
  orange: 'bg-orange-500',
  amber: 'bg-amber-500',
  green: 'bg-emerald-500',
  teal: 'bg-teal-500',
  blue: 'bg-blue-500',
  violet: 'bg-violet-500',
  pink: 'bg-pink-500',
}

/** Priority dot: only urgent / high are loud; the rest stay neutral. */
export const PRIORITY_DOT: Record<ConversationPriority, string> = {
  urgent: 'bg-red-500',
  high: 'bg-amber-500',
  normal: 'bg-zinc-400',
  low: 'bg-zinc-300 dark:bg-zinc-600',
}

export function isPriority(v: unknown): v is ConversationPriority {
  return typeof v === 'string' && (PRIORITIES as readonly string[]).includes(v)
}
export function isSentiment(v: unknown): v is ConversationSentiment {
  return typeof v === 'string' && (SENTIMENTS as readonly string[]).includes(v)
}
export function isResolution(v: unknown): v is ConversationResolution {
  return typeof v === 'string' && (RESOLUTIONS as readonly string[]).includes(v)
}
export function isCategoryColor(v: unknown): v is CategoryColor {
  return typeof v === 'string' && (CATEGORY_COLORS as readonly string[]).includes(v)
}

/** A row of `conversation_categories`. */
export interface ConversationCategory {
  id: string
  account_id: string
  name: string
  description: string | null
  color: CategoryColor
  default_priority: ConversationPriority
  position: number
  archived_at: string | null
}

export const CATEGORY_LIMITS = { name: 40, description: 200, subject: 120 } as const

export interface SupportCopy {
  category: string
  priority: string
  noCategory: string
  noCategoryShort: string
  priorities: Record<ConversationPriority, string>
  sentiments: Record<ConversationSentiment, string>
  sentiment: string
  resolutions: Record<ConversationResolution, string>
  resolveAs: string
  resolutionLabel: string
  subjectPlaceholder: string
  subjectAdd: string
  subjectLabel: string
  classify: string
  classifying: string
  classified: string
  classifyNothing: string
  classifyManual: string
  reclassify: string
  reclassifyBody: string
  classifyDisabled: string
  classifyFailed: string
  autoClassified: string
  saveFailed: string
  readOnly: string
  /** Activity / thread sentences. */
  eventCategorySet: (name: string) => string
  eventCategoryCleared: string
  eventPriority: (label: string) => string
  eventResolution: (label: string) => string
  viewer: string
}

export const SUPPORT_COPY: Record<Language, SupportCopy> = {
  'pt-BR': {
    category: 'Categoria',
    priority: 'Prioridade',
    noCategory: 'Sem categoria',
    noCategoryShort: 'Categoria',
    priorities: { low: 'Baixa', normal: 'Normal', high: 'Alta', urgent: 'Urgente' },
    sentiments: { negative: 'negativo', neutral: 'neutro', positive: 'positivo' },
    sentiment: 'Sentimento',
    resolutions: {
      resolved: 'Resolvida',
      not_applicable: 'Não procede',
      closed_by_customer: 'Encerrada pelo cliente',
      expired: 'Sem resposta do cliente',
      duplicate: 'Duplicada',
    },
    resolveAs: 'Resolver como…',
    resolutionLabel: 'Desfecho',
    subjectPlaceholder: 'Adicionar assunto',
    subjectAdd: 'Adicionar assunto',
    subjectLabel: 'Assunto',
    classify: 'Classificar',
    classifying: 'Classificando…',
    classified: 'Conversa classificada',
    classifyNothing: 'Sem certeza suficiente para classificar',
    classifyManual: 'Você já classificou esta conversa',
    reclassify: 'Reclassificar com IA',
    reclassifyBody: 'Substitui a classificação atual desta conversa.',
    classifyDisabled: 'Ative a classificação em Configurações > Suporte',
    classifyFailed: 'Não foi possível classificar',
    autoClassified: 'Classificada automaticamente',
    saveFailed: 'Não foi possível salvar',
    readOnly: 'Somente leitura',
    eventCategorySet: (name) => `Categoria definida: ${name}`,
    eventCategoryCleared: 'Categoria removida',
    eventPriority: (label) => `Prioridade: ${label}`,
    eventResolution: (label) => `Desfecho: ${label}`,
    viewer: 'Somente leitura',
  },
  'en-US': {
    category: 'Category',
    priority: 'Priority',
    noCategory: 'No category',
    noCategoryShort: 'Category',
    priorities: { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' },
    sentiments: { negative: 'negative', neutral: 'neutral', positive: 'positive' },
    sentiment: 'Sentiment',
    resolutions: {
      resolved: 'Resolved',
      not_applicable: 'Not applicable',
      closed_by_customer: 'Closed by customer',
      expired: 'No reply from customer',
      duplicate: 'Duplicate',
    },
    resolveAs: 'Resolve as…',
    resolutionLabel: 'Outcome',
    subjectPlaceholder: 'Add a subject',
    subjectAdd: 'Add a subject',
    subjectLabel: 'Subject',
    classify: 'Classify',
    classifying: 'Classifying…',
    classified: 'Conversation classified',
    classifyNothing: 'Not confident enough to classify',
    classifyManual: 'You already classified this conversation',
    reclassify: 'Reclassify with AI',
    reclassifyBody: 'Replaces the current classification of this conversation.',
    classifyDisabled: 'Turn on classification in Settings > Support',
    classifyFailed: 'Could not classify',
    autoClassified: 'Classified automatically',
    saveFailed: 'Could not save',
    readOnly: 'Read only',
    eventCategorySet: (name) => `Category set: ${name}`,
    eventCategoryCleared: 'Category removed',
    eventPriority: (label) => `Priority: ${label}`,
    eventResolution: (label) => `Outcome: ${label}`,
    viewer: 'Read only',
  },
}

export function supportCopy(language: Language): SupportCopy {
  return SUPPORT_COPY[language] ?? SUPPORT_COPY['pt-BR']
}

/** Active (non-archived) categories, in display order. */
export function activeCategories(list: readonly ConversationCategory[]): ConversationCategory[] {
  return list
    .filter((c) => !c.archived_at)
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
}

/** Category lookup that also finds archived ones (old conversations keep showing them). */
export function categoryMap(list: readonly ConversationCategory[]): Map<string, ConversationCategory> {
  return new Map(list.map((c) => [c.id, c]))
}
