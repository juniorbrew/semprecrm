// GET /api/integrations/microsoft/callback — the provider redirects here with
// `code` + `state`; the connection is saved (tokens encrypted), an
// initial sync runs and the browser goes back to Settings → Agenda.
import { handleCallback } from '@/lib/calendar/sync/oauth'

export async function GET(request: Request) {
  return handleCallback(request, 'microsoft')
}
