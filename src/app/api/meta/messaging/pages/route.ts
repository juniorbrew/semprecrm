// GET  /api/meta/messaging/pages?session=… — the Facebook Pages to choose from (no tokens).
// POST /api/meta/messaging/pages {session, page_id} — connect the chosen Page.
// DELETE /api/meta/messaging/pages?session=… — cancel: drop the parked Pages.
import { handleCancelSession, handleListPages, handlePickPage } from '@/lib/meta-messaging/connect/handlers'

export const dynamic = 'force-dynamic'

export const GET = handleListPages
export const POST = handlePickPage
export const DELETE = handleCancelSession
