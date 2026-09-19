import { NextResponse } from "next/server";

import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { lookupCep, type LookupFailure } from "@/lib/br/lookup-server";

// ============================================================
// GET /api/lookup/cep/[cep] — public.
//
// Unauthenticated on purpose: the signup page calls it before an
// account exists. Per-IP rate-limited; the upstream call, cache and
// provider fallback live in src/lib/br/lookup-server.ts.
//
//   200 { ok: true, address }
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
  { params }: { params: Promise<{ cep: string }> },
) {
  const ip = getClientIp(request);
  const limit = checkRateLimit(`lookup:cep:${ip}`, RATE_LIMITS.lookup);
  if (!limit.success) return rateLimitResponse(limit);

  const { cep } = await params;
  const result = await lookupCep(typeof cep === "string" ? cep : "");
  if (!result.ok) {
    return NextResponse.json(result, { status: STATUS[result.reason] });
  }
  return NextResponse.json(result, {
    headers: { "cache-control": "private, max-age=86400" },
  });
}
