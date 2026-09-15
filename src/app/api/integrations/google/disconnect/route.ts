// POST /api/integrations/google/disconnect — revoke (best-effort), delete
// the connection, drop the imported events and detach the mirrored ones.
import { handleDisconnect } from '@/lib/calendar/sync/oauth'

export async function POST() {
  return handleDisconnect('google')
}
