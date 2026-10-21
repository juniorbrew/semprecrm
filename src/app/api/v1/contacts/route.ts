import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { apiError, authenticateApiKey } from '@/lib/api-keys/auth'
import { findExistingContact } from '@/lib/contacts/dedupe'
import { isValidE164, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils'

export const dynamic = 'force-dynamic'

/** GET /api/v1/contacts?phone=5511999990000 — 404 when the number is unknown. Needs `contacts:read`. */
export async function GET(request: Request) {
  const auth = await authenticateApiKey(request, 'contacts:read')
  if (!auth.ok) return auth.response

  const phone = sanitizePhoneForMeta(new URL(request.url).searchParams.get('phone') ?? '')
  if (!isValidE164(phone)) {
    return apiError(400, 'invalid_phone', '"phone" must be a valid phone in international format.')
  }
  const c = await findExistingContact(supabaseAdmin(), auth.ctx.accountId, phone)
  if (!c) return apiError(404, 'not_found', 'No contact with this phone.')
  return NextResponse.json({
    object: 'contact',
    id: c.id,
    phone: c.phone,
    name: c.name ?? null,
    email: (c.email as string | null) ?? null,
    company: (c.company as string | null) ?? null,
    created_at: c.created_at ?? null,
  })
}
