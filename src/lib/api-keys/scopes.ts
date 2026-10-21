// Client-safe constants (no node imports): shared by the settings UI and keys.ts.
export const API_KEY_SCOPES = ['messages:send', 'contacts:read'] as const
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number]

export const API_KEY_SCOPE_DESCRIPTIONS: Record<ApiKeyScope, string> = {
  'messages:send': 'Send WhatsApp messages',
  'contacts:read': 'Look up contacts by phone',
}

export const MAX_GRACE_HOURS = 24 * 7
export const DEFAULT_GRACE_HOURS = 24
