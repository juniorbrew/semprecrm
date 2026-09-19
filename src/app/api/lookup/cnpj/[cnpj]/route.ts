import { NextResponse } from "next/server";

import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { lookupCnpj, type LookupFailure } from "@/lib/br/lookup-server";

// ============================================================
// GET /api/lookup/cnpj/[cnpj] — public.
//
// Unauthenticated on purpose: the signup page calls it before an
// account exists. Per-IP rate-limited; the upstream call, cache and
// provider fallback live in src/lib/br/lookup-server.ts.
//
//   200 { ok: true, company }
//   404 { ok: false, reason: "not_found" }
//   422 { ok: false, reason: "invalid" }        malformed document
//   502 { ok: false, reason: "upstream_error" } source unreachable
// ============================================================

const STATUS: Record<LookupFailure, number> = {
  invalid: 422,
  not_found: 404,
  upstream_error: 502,
};

function getClientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const xri = request.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ cnpj: string }> },
) {
  const ip = getClientIp(request);
  const limit = checkRateLimit(`lookup:cnpj:${ip}`, RATE_LIMITS.lookup);
  if (!limit.success) return rateLimitResponse(limit);

  const { cnpj } = await params;
  const result = await lookupCnpj(typeof cnpj === "string" ? cnpj : "");
  if (!result.ok) {
    return NextResponse.json(result, { status: STATUS[result.reason] });
  }
  return NextResponse.json(result, {
    headers: { "cache-control": "private, max-age=3600" },
  });
}
