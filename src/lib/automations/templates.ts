import type {
  AutomationStepConfig,
  AutomationStepType,
  AutomationTriggerConfig,
  AutomationTriggerType,
} from '@/types';
import type { Language } from '@/lib/i18n';

export type TemplateSlug =
  | 'welcome_message'
  | 'out_of_office'
  | 'lead_qualifier'
  | 'follow_up_reminder'
  | 'revive_cold_conversation';

export interface TemplateStepSeed {
  step_type: AutomationStepType;
  step_config: AutomationStepConfig;
  branch?: 'yes' | 'no' | null;
  /** Index (within this seed list) of the Condition parent, if nested. */
  parent_index?: number | null;
}

export interface AutomationTemplateDefinition {
  slug: TemplateSlug;
  name: string;
  description: string;
  trigger_type: AutomationTriggerType;
  trigger_config: AutomationTriggerConfig;
  steps: TemplateStepSeed[];
}

export const AUTOMATION_TEMPLATES: Record<
  TemplateSlug,
  AutomationTemplateDefinition
> = {
  welcome_message: {
    slug: 'welcome_message',
    name: 'Welcome Message',
    description: 'Auto-reply to first-time contacts with a greeting.',
    // first_inbound_message (added in PR #33) catches both brand-new
    // contacts AND manually-added/imported contacts on their first-ever
    // reply, which is what a user setting up a "welcome" automation
    // almost always wants. new_contact_created would miss the
    // manually-imported case.
    trigger_type: 'first_inbound_message',
    trigger_config: {},
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text: "Hi! 👋 Thanks for reaching out. We'll get back to you shortly.",
        },
      },
      {
        step_type: 'add_tag',
        step_config: { tag_id: '' },
      },
    ],
  },
  out_of_office: {
    slug: 'out_of_office',
    name: 'Out of Office',
    description: 'Auto-reply during off-hours so nobody is left waiting.',
    trigger_type: 'new_message_received',
    trigger_config: {},
    steps: [
      {
        step_type: 'condition',
        step_config: {
          subject: 'time_of_day',
          operand: '18:00-09:00',
        },
      },
      {
        step_type: 'send_message',
        step_config: {
          text: 'Thanks for your message! Our team is offline right now (9am–6pm) and will reply first thing tomorrow.',
        },
        parent_index: 0,
        branch: 'yes',
      },
    ],
  },
  lead_qualifier: {
    slug: 'lead_qualifier',
    name: 'Lead Qualifier',
    description: 'Ask qualification questions to filter inbound leads.',
    trigger_type: 'keyword_match',
    trigger_config: {
      keywords: ['pricing', 'quote', 'buy'],
      match_type: 'contains',
    },
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text: 'Great — happy to help with pricing! Quick question: roughly how many seats are you looking for?',
        },
      },
      {
        step_type: 'wait',
        step_config: { amount: 10, unit: 'minutes' },
      },
      {
        step_type: 'assign_conversation',
        step_config: { mode: 'round_robin' },
      },
    ],
  },
  follow_up_reminder: {
    slug: 'follow_up_reminder',
    name: 'Follow-up Reminder',
    description: 'Send a nudge if a contact has not replied within 24 hours.',
    trigger_type: 'new_message_received',
    trigger_config: {},
    steps: [
      {
        step_type: 'wait',
        step_config: { amount: 1, unit: 'days' },
      },
      {
        step_type: 'send_message',
        step_config: {
          text: 'Just circling back — did you have any other questions for us? Happy to help!',
        },
      },
    ],
  },
  revive_cold_conversation: {
    slug: 'revive_cold_conversation',
    name: 'Revive a cold conversation',
    description:
      'When the customer goes quiet for 24 hours after your last message, send a gentle nudge.',
    // conversation_inactive (migration 030) is evaluated by the cron scan
    // rather than by an inbound event: once per silence, re-armed by the
    // next message either way.
    trigger_type: 'conversation_inactive',
    trigger_config: { hours: 24, last_from: 'agent', statuses: ['open', 'pending'] },
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text: 'Hi {{contact.name}}, any questions left? I am here if you need anything.',
        },
      },
    ],
  },
};

export function getTemplate(slug: string): AutomationTemplateDefinition | null {
  return AUTOMATION_TEMPLATES[slug as TemplateSlug] ?? null;
}

const PT_BR_TEMPLATE_COPY: Record<
  TemplateSlug,
  { name: string; description: string; messages: Record<string, string> }
> = {
  welcome_message: {
    name: 'Mensagem de boas-vindas',
    description:
      'Responda automaticamente ao primeiro contato com uma saudação.',
    messages: {
      "Hi! 👋 Thanks for reaching out. We'll get back to you shortly.":
        'Olá! 👋 Obrigado por entrar em contato. Retornaremos em breve.',
    },
  },
  out_of_office: {
    name: 'Fora do horário',
    description: 'Responda fora do expediente para ninguém ficar esperando.',
    messages: {
      'Thanks for your message! Our team is offline right now (9am–6pm) and will reply first thing tomorrow.':
        'Obrigado pela mensagem! Nossa equipe está fora do expediente agora (9h–18h) e responderá amanhã no início do dia.',
    },
  },
  lead_qualifier: {
    name: 'Qualificação de lead',
    description:
      'Faça perguntas de qualificação para filtrar os leads recebidos.',
    messages: {
      'Great — happy to help with pricing! Quick question: roughly how many seats are you looking for?':
        'Ótimo — será um prazer ajudar! Uma pergunta rápida: aproximadamente quantas licenças você procura?',
    },
  },
  follow_up_reminder: {
    name: 'Lembrete de acompanhamento',
    description:
      'Envie um lembrete se o contato não responder em até 24 horas.',
    messages: {
      'Just circling back — did you have any other questions for us? Happy to help!':
        'Passando para acompanhar — ficou alguma dúvida? Será um prazer ajudar!',
    },
  },
  revive_cold_conversation: {
    name: 'Retomar conversa fria',
    description:
      'Quando o cliente fica 24 horas sem responder à sua última mensagem, envie um lembrete gentil.',
    messages: {
      'Hi {{contact.name}}, any questions left? I am here if you need anything.':
        'Oi {{contact.name}}, ficou alguma dúvida? Estou por aqui se precisar de algo.',
    },
  },
};

export function localizeAutomationTemplate(
  template: AutomationTemplateDefinition,
  language: Language
): AutomationTemplateDefinition {
  if (language !== 'pt-BR') return template;
  const copy = PT_BR_TEMPLATE_COPY[template.slug];
  return {
    ...template,
    name: copy.name,
    description: copy.description,
    trigger_config:
      template.slug === 'lead_qualifier'
        ? {
            ...template.trigger_config,
            keywords: ['preço', 'orçamento', 'comprar'],
          }
        : template.trigger_config,
    steps: template.steps.map((step) => ({
      ...step,
      step_config:
        'text' in step.step_config &&
        typeof step.step_config.text === 'string' &&
        copy.messages[step.step_config.text]
          ? { ...step.step_config, text: copy.messages[step.step_config.text] }
          : step.step_config,
    })),
  };
}
