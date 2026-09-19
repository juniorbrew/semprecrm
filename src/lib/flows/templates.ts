/**
 * Starter flow templates.
 *
 * Three pre-canned flows users can clone with one click instead of
 * building from scratch. Each template is a plain JS object describing
 * the same shape `/api/flows` PUT accepts — name, trigger config,
 * entry_node_id, fallback_policy, nodes[] — keyed by a stable
 * `slug`.
 *
 * The clone path (`/api/flows` POST with `template_slug`) creates a
 * NEW flow_row + flow_nodes rows for the user. `node_key`s are kept
 * verbatim (they're stable strings, not UUIDs, so cloning never
 * needs to rewrite edge references).
 *
 * Choosing a single static module over a DB-backed gallery for v1
 * because: (a) the set is small and changes with code releases, not
 * data; (b) keeps templates portable across self-hosted instances
 * without migrations; (c) editing in source is the lowest-friction
 * way to add the next template.
 */

import type {
  CollectInputNodeConfig,
  ConditionNodeConfig,
  HandoffNodeConfig,
  KeywordTriggerConfig,
  SendButtonsNodeConfig,
  SendListNodeConfig,
  SendMessageNodeConfig,
  StartNodeConfig,
} from "./types";

export type FlowTemplateNodeType =
  | "start"
  | "send_message"
  | "send_buttons"
  | "send_list"
  | "collect_input"
  | "condition"
  | "set_tag"
  | "handoff"
  | "end";

export interface FlowTemplateNode {
  node_key: string;
  node_type: FlowTemplateNodeType;
  config:
    | StartNodeConfig
    | SendMessageNodeConfig
    | SendButtonsNodeConfig
    | SendListNodeConfig
    | CollectInputNodeConfig
    | ConditionNodeConfig
    | HandoffNodeConfig
    | Record<string, unknown>;
}

export interface FlowTemplate {
  slug: string;
  name: string;
  description: string;
  /** Used by the gallery to surface a relevant icon. lucide-react name. */
  icon: "MessageSquare" | "HelpCircle" | "UserPlus";
  trigger_type: "keyword" | "first_inbound_message" | "manual";
  trigger_config: KeywordTriggerConfig | Record<string, unknown>;
  entry_node_id: string;
  nodes: FlowTemplateNode[];
}

// ============================================================
// 1. Welcome menu — the example from the owner's brief
// ============================================================
const WELCOME_MENU: FlowTemplate = {
  slug: "welcome_menu",
  name: "Welcome menu",
  description:
    "Greet customers who type a keyword and route them to the right agent based on whether they're new or existing.",
  icon: "MessageSquare",
  trigger_type: "keyword",
  trigger_config: { keywords: ["support", "help", "hi"], match_type: "contains" },
  entry_node_id: "start",
  nodes: [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "welcome" },
    },
    {
      node_key: "welcome",
      node_type: "send_buttons",
      config: {
        text: "Hi! 👋 Welcome to support. Are you an existing customer or new here?",
        footer_text: "Tap a button below to continue.",
        buttons: [
          {
            reply_id: "existing",
            title: "Existing customer",
            next_node_key: "existing_handoff",
          },
          {
            reply_id: "new",
            title: "New customer",
            next_node_key: "new_handoff",
          },
        ],
      } as SendButtonsNodeConfig,
    },
    {
      node_key: "existing_handoff",
      node_type: "handoff",
      config: {
        note: "Existing customer needs assistance — please check account history before replying.",
      } as HandoffNodeConfig,
    },
    {
      node_key: "new_handoff",
      node_type: "handoff",
      config: {
        note: "New customer — share pricing + onboarding link.",
      } as HandoffNodeConfig,
    },
  ],
};

// ============================================================
// 2. FAQ bot — list-message answers, fully automated
// ============================================================
const FAQ_BOT: FlowTemplate = {
  slug: "faq_bot",
  name: "FAQ bot",
  description:
    "Answer common questions automatically. Customer picks a topic from a list; the bot replies with the answer and ends.",
  icon: "HelpCircle",
  trigger_type: "keyword",
  trigger_config: {
    keywords: ["faq", "question", "info"],
    match_type: "contains",
  },
  entry_node_id: "start",
  nodes: [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "topics" },
    },
    {
      node_key: "topics",
      node_type: "send_list",
      config: {
        text: "What can I help you with?",
        button_label: "View topics",
        sections: [
          {
            title: "Common questions",
            rows: [
              {
                reply_id: "hours",
                title: "Opening hours",
                next_node_key: "answer_hours",
              },
              {
                reply_id: "pricing",
                title: "Pricing",
                next_node_key: "answer_pricing",
              },
              {
                reply_id: "refunds",
                title: "Refund policy",
                next_node_key: "answer_refunds",
              },
            ],
          },
          {
            title: "Other",
            rows: [
              {
                reply_id: "human",
                title: "Talk to a human",
                next_node_key: "human_handoff",
              },
            ],
          },
        ],
      } as SendListNodeConfig,
    },
    {
      node_key: "answer_hours",
      node_type: "send_message",
      config: {
        text: "We're open Mon–Fri, 9am–6pm local time. Weekend support is limited to urgent issues.",
        next_node_key: "end",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "answer_pricing",
      node_type: "send_message",
      config: {
        text: "Our pricing starts at $9/mo. Visit https://example.com/pricing for the full breakdown.",
        next_node_key: "end",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "answer_refunds",
      node_type: "send_message",
      config: {
        text: "Refunds are honored within 30 days of purchase. Reply with your order number and we'll process it.",
        next_node_key: "end",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "human_handoff",
      node_type: "handoff",
      config: {
        note: "Customer asked to talk to a human from the FAQ bot.",
      } as HandoffNodeConfig,
    },
    {
      node_key: "end",
      node_type: "end",
      config: {},
    },
  ],
};

// ============================================================
// 3. Lead capture — collect_input chain, ends in a handoff
// ============================================================
const LEAD_CAPTURE: FlowTemplate = {
  slug: "lead_capture",
  name: "Lead capture",
  description:
    "Greet first-time inbounds, capture name + email + company, then hand off to sales with the answers in the note.",
  icon: "UserPlus",
  trigger_type: "first_inbound_message",
  trigger_config: {},
  entry_node_id: "start",
  nodes: [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "intro" },
    },
    {
      node_key: "intro",
      node_type: "send_message",
      config: {
        text: "Welcome! 👋 I'll ask a few quick questions so we can get you to the right person.",
        next_node_key: "ask_name",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "ask_name",
      node_type: "collect_input",
      config: {
        prompt_text: "What's your name?",
        var_key: "name",
        next_node_key: "ask_email",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "ask_email",
      node_type: "collect_input",
      config: {
        prompt_text: "Thanks {{vars.name}}! What's your work email?",
        var_key: "email",
        next_node_key: "ask_company",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "ask_company",
      node_type: "collect_input",
      config: {
        prompt_text: "Almost done — what's your company name?",
        var_key: "company",
        next_node_key: "handoff",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "handoff",
      node_type: "handoff",
      config: {
        note: "New lead — name={{vars.name}}, email={{vars.email}}, company={{vars.company}}.",
      } as HandoffNodeConfig,
    },
  ],
};

// ============================================================
// Registry
// ============================================================

const TEMPLATES: Record<string, FlowTemplate> = {
  welcome_menu: WELCOME_MENU,
  faq_bot: FAQ_BOT,
  lead_capture: LEAD_CAPTURE,
};

export function getFlowTemplate(slug: string): FlowTemplate | null {
  return TEMPLATES[slug] ?? null;
}

export function listFlowTemplates(): FlowTemplate[] {
  return Object.values(TEMPLATES);
}

// ============================================================
// Localisation
// ============================================================

/**
 * pt-BR copy for everything a template puts in front of a customer or
 * an agent: gallery name/description, trigger keywords, message bodies,
 * button/row titles and handoff notes. Keyed by the English source
 * string so the English template stays the single structural source of
 * truth and a missing entry degrades to English rather than to a blank.
 */
const PT_BR_TEMPLATE_COPY: Record<string, string> = {
  // Gallery
  "Welcome menu": "Menu de boas-vindas",
  "Greet customers who type a keyword and route them to the right agent based on whether they're new or existing.":
    "Receba clientes que digitam uma palavra-chave e encaminhe-os ao responsável certo conforme sejam novos ou já clientes.",
  "FAQ bot": "Bot de perguntas frequentes",
  "Answer common questions automatically. Customer picks a topic from a list; the bot replies with the answer and ends.":
    "Responda perguntas comuns automaticamente. O cliente escolhe um tópico da lista; o bot responde e encerra.",
  "Lead capture": "Captura de leads",
  "Greet first-time inbounds, capture name + email + company, then hand off to sales with the answers in the note.":
    "Receba quem escreve pela primeira vez, capture nome, e-mail e empresa e transfira para vendas com as respostas na nota.",
  // Keywords
  support: "suporte",
  help: "ajuda",
  hi: "oi",
  faq: "faq",
  question: "dúvida",
  info: "info",
  // Welcome menu
  "Hi! 👋 Welcome to support. Are you an existing customer or new here?":
    "Olá! 👋 Boas-vindas ao suporte. Você já é cliente ou é a primeira vez por aqui?",
  "Tap a button below to continue.": "Toque em um botão abaixo para continuar.",
  "Existing customer": "Já sou cliente",
  "New customer": "Novo cliente",
  "Existing customer needs assistance — please check account history before replying.":
    "Cliente existente precisa de ajuda — verifique o histórico da conta antes de responder.",
  "New customer — share pricing + onboarding link.":
    "Novo cliente — envie os preços e o link de integração.",
  // FAQ bot
  "What can I help you with?": "Como posso ajudar?",
  "View topics": "Ver tópicos",
  "Common questions": "Perguntas comuns",
  "Opening hours": "Horário de atendimento",
  Pricing: "Preços",
  "Refund policy": "Política de reembolso",
  Other: "Outros",
  "Talk to a human": "Falar com uma pessoa",
  "We're open Mon–Fri, 9am–6pm local time. Weekend support is limited to urgent issues.":
    "Atendemos de segunda a sexta, das 9h às 18h. Nos fins de semana, apenas casos urgentes.",
  "Our pricing starts at $9/mo. Visit https://example.com/pricing for the full breakdown.":
    "Nossos planos começam em R$ 9/mês. Acesse https://example.com/pricing para ver todos os detalhes.",
  "Refunds are honored within 30 days of purchase. Reply with your order number and we'll process it.":
    "Reembolsos são aceitos em até 30 dias após a compra. Responda com o número do pedido e nós cuidamos do resto.",
  "Customer asked to talk to a human from the FAQ bot.":
    "O cliente pediu para falar com uma pessoa pelo bot de perguntas frequentes.",
  // Lead capture
  "Welcome! 👋 I'll ask a few quick questions so we can get you to the right person.":
    "Boas-vindas! 👋 Vou fazer algumas perguntas rápidas para encaminhar você à pessoa certa.",
  "What's your name?": "Qual é o seu nome?",
  "Thanks {{vars.name}}! What's your work email?":
    "Perfeito, {{vars.name}}! Qual é o seu e-mail profissional?",
  "Almost done — what's your company name?":
    "Quase lá — qual é o nome da sua empresa?",
  "New lead — name={{vars.name}}, email={{vars.email}}, company={{vars.company}}.":
    "Novo lead — nome={{vars.name}}, e-mail={{vars.email}}, empresa={{vars.company}}.",
};

/** Config keys that hold copy (everything else — ids, keys, refs — is structural). */
const COPY_KEYS = new Set([
  "text",
  "footer_text",
  "button_label",
  "note",
  "prompt_text",
  "caption",
  "title",
  "description",
]);

function localizeCopy(value: unknown, copy: Record<string, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => localizeCopy(v, copy));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] =
        COPY_KEYS.has(k) && typeof v === "string"
          ? (copy[v] ?? v)
          : localizeCopy(v, copy);
    }
    return out;
  }
  return value;
}

/**
 * Returns the template with its copy rendered in `language`. en-US is
 * the source, so it comes back untouched; pt-BR maps every known string
 * (name, description, keywords, node copy) and leaves unknown ones as
 * they are. Structure — node keys, reply ids, edges — never changes.
 */
export function localizeFlowTemplate(
  template: FlowTemplate,
  language: "pt-BR" | "en-US",
): FlowTemplate {
  if (language !== "pt-BR") return template;
  const copy = PT_BR_TEMPLATE_COPY;
  const keywords = (template.trigger_config as KeywordTriggerConfig).keywords;
  return {
    ...template,
    name: copy[template.name] ?? template.name,
    description: copy[template.description] ?? template.description,
    trigger_config: Array.isArray(keywords)
      ? {
          ...template.trigger_config,
          keywords: keywords.map((k) => copy[k] ?? k),
        }
      : template.trigger_config,
    nodes: template.nodes.map((n) => ({
      ...n,
      config: localizeCopy(n.config, copy) as FlowTemplateNode["config"],
    })),
  };
}
