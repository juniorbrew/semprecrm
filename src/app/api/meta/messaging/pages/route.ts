// GET  /api/meta/messaging/pages?session=… — the Facebook Pages to choose from (no tokens).
// POST /api/meta/messaging/pages {session, page_id} — connect the chosen Page.
import { handleListPages, handlePickPage } from '@/lib/meta-messaging/connect/handlers'

export const dynamic = 'force-dynamic'

export const GET = handleListPages
export const POST = handlePickPage
