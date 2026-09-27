import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { isValidCnpj, normalizeTaxId } from '@/lib/br/documents'
import { lookupCnpj, type LookupFailure } from '@/lib/br/lookup-server'
import { findCompanyByCnpj } from '@/lib/companies/data'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

// ============================================================
// GET /api/companies/lookup/[cnpj] — "Buscar dados" in the company
// form (Empresas). Agent+, since only writers fill that form.
//
// Same upstream chain and cache as the public /api/lookup/cnpj (the
// signup page's), but authenticated and rate-limited per user rather
// than per IP, and it also answers whether the caller's account
// already has a company with this CNPJ — so the form can warn before
// the user retypes a company that exists.
//
//   200 { ok: true, company, existing }
//   404 { ok: false, reason: "not_found", existing }
//   422 { ok: false, reason: "invalid", existing: null }
//   502 { ok: false, reason: "upstream_error", existing }
//   401 / 403 from requireRole, 429 from the rate limiter.
//
// `existing` is `{ id, razao_social, nome_fantasia, cnpj, cidade, uf }`
// or null. The duplicate check runs even when the public sources are
// down or do not know the CNPJ.
// ============================================================

const STATUS: Record<LookupFailure, number> = {
  invalid: 422,
  not_found: 404,
  upstream_error: 502,
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ cnpj: string }> },
) {
  try {
    const ctx = await requireRole('agent')

    const limit = checkRateLimit(`lookup:cnpj:user:${ctx.userId}`, RATE_LIMITS.lookup)
    if (!limit.success) return rateLimitResponse(limit)

    const { cnpj: raw } = await params
    const cnpj = normalizeTaxId(typeof raw === 'string' ? raw : '')
    if (!isValidCnpj(cnpj)) {
      return NextResponse.json({ ok: false, reason: 'invalid', existing: null }, { status: 422 })
    }

    const [result, existing] = await Promise.all([
      lookupCnpj(cnpj),
      findCompanyByCnpj(ctx.supabase, cnpj, { accountId: ctx.accountId }).catch((err) => {
        console.error('[GET /api/companies/lookup] duplicate check failed:', err)
        return null
      }),
    ])

    const headers = { 'cache-control': 'private, no-store' }
    if (!result.ok) {
      return NextResponse.json({ ...result, existing }, { status: STATUS[result.reason], headers })
    }
    return NextResponse.json({ ...result, existing }, { headers })
  } catch (err) {
    return toErrorResponse(err)
  }
}
