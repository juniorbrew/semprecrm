// GET /api/integrations/google/connect — start the OAuth flow for the
// session user (Settings → Agenda → Conectar). See src/lib/calendar/sync/oauth.ts.
import { handleConnect } from '@/lib/calendar/sync/oauth'

export async function GET(request: Request) {
  return handleConnect(request, 'google')
}
