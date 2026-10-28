// POST /api/meta/messaging/disconnect {kind} — unsubscribe at Meta (best effort) and remove the connection.
import { handleDisconnect } from '@/lib/meta-messaging/connect/handlers'

export const dynamic = 'force-dynamic'

export const POST = handleDisconnect
