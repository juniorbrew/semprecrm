// ============================================================
// Site bot (feature 4.7) — the shape of `lead_sources.bot_config`
// (migration 108). Pure types; logic lives next to this file.
// ============================================================

export type BotQuestionType = 'text' | 'choice' | 'name' | 'phone' | 'email'

/** Where a free-text / choice answer goes. name/phone/email types are fixed. */
export type BotQuestionTarget = 'note' | 'custom'

export interface BotQuestion {
  /** `^[a-z][a-z0-9_]{0,23}$`, unique inside the bot. */
  id: string
  text: string
  type: BotQuestionType
  /** Only for `choice`: 2..6 labels, the answer must equal one. */
  options?: string[]
  required: boolean
  /** text/choice only. Default `note`. */
  target?: BotQuestionTarget
  /** Required when `target === 'custom'`: contact custom field id. */
  customFieldId?: string
}

export interface BotConfig {
  appearance: {
    botName: string
    /** `#rrggbb` */
    color: string
    bubbleText: string
    side: 'right' | 'left'
  }
  greeting: string
  questions: BotQuestion[]
  end: {
    thanks: string
    whatsappEnabled: boolean
    /** Digits only (country code included); '' when the button is off. */
    whatsappNumber: string
    /** May contain `{nome}`. */
    messageTemplate: string
  }
  lgpd: {
    text: string
    /** https URL or ''. */
    linkUrl: string
  }
  /** Normalised hostnames (no scheme, port or leading www.). */
  domains: string[]
}

/** What GET /api/v1/robo/[key] returns — nothing internal. */
export interface PublicBotConfig {
  name: string
  color: string
  bubbleText: string
  side: 'right' | 'left'
  greeting: string
  questions: { id: string; text: string; type: BotQuestionType; options?: string[]; required: boolean }[]
  consent: { text: string; linkUrl: string }
  thanks: string
  /** Whether the end screen offers WhatsApp; the link comes with the POST response. */
  whatsapp: boolean
}

export const BOT_LIMITS = {
  maxQuestions: 10,
  maxOptions: 6,
  minOptions: 2,
  maxDomains: 10,
  botName: 40,
  bubbleText: 60,
  greeting: 300,
  question: 200,
  option: 60,
  thanks: 300,
  lgpdText: 300,
  messageTemplate: 300,
  url: 300,
  answer: 500,
  name: 80,
  email: 254,
  payloadBytes: 8 * 1024,
  minConversationMs: 3000,
} as const
