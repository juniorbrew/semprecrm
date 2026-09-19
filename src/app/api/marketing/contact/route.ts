// ============================================================
// POST /api/marketing/contact
//
// Public — no auth required. Backs the /contato form on the
// marketing site. Writes straight to `contact_submissions` via
// the service-role client (RLS on that table denies anon/authed
// writes entirely — this route is the only writer) and never
// sends email; someone checks the table directly for now.
// ============================================================

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { supabaseServerUrl } from "@/lib/supabase/url";
import { validateContactSubmission } from "@/lib/marketing/contact";

// Lazy-initialized to avoid build-time crash when env vars are missing,
// matching src/app/api/whatsapp/webhook/route.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(supabaseServerUrl(), process.env.SUPABASE_SERVICE_ROLE_KEY!);
  }
  return _adminClient;
}

function getClientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const xri = request.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const limit = checkRateLimit(`marketing-contact:${ip}`, RATE_LIMITS.marketingContact);
  if (!limit.success) {
    // rateLimitResponse() (src/lib/rate-limit.ts) is shared with every other
    // route and returns "Rate limit exceeded" — this page is pt-BR, so this
    // route builds its own 429 with the same status/headers instead of
    // translating the shared helper's message for every other caller.
    const retryAfterSec = Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000));
    return NextResponse.json(
      {
        error: "Muitas tentativas. Aguarde um minuto e tente novamente.",
        retry_after_seconds: retryAfterSec,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfterSec),
          "X-RateLimit-Limit": String(limit.limit),
          "X-RateLimit-Remaining": String(limit.remaining),
          "X-RateLimit-Reset": String(Math.ceil(limit.reset / 1000)),
        },
      },
    );
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const result = validateContactSubmission({
    name: body.name,
    email: body.email,
    company: body.company,
    message: body.message,
    website: body.website,
  });

  if (!result.ok) {
    // A filled honeypot gets the same generic success response as a
    // real submission, so a bot can't tell it was rejected — but
    // nothing is written.
    if (result.isSpam) {
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  const { error } = await supabaseAdmin()
    .from("contact_submissions")
    .insert({
      name: result.data.name,
      email: result.data.email,
      company: result.data.company,
      message: result.data.message,
      source: "contato",
    });

  if (error) {
    console.error("[marketing/contact] insert error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
