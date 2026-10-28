// GET /api/meta/messaging/status — per channel: are the platform's app keys set, and the account's connection (no token).
import { handleStatus } from '@/lib/meta-messaging/connect/handlers'

export const dynamic = 'force-dynamic'

export const GET = handleStatus
