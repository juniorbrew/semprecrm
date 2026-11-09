// Server-only: the bot's public key is minted here (16 random bytes, hex)
// and never by the browser, like the webhook token.
import { randomBytes } from 'node:crypto'

export const BOT_KEY_RE = /^[0-9a-f]{32}$/

export function generateBotPublicKey(): string {
  return randomBytes(16).toString('hex')
}

export function isBotPublicKey(value: unknown): value is string {
  return typeof value === 'string' && BOT_KEY_RE.test(value)
}
