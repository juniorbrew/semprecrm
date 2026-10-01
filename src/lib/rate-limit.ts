/**
 * In-memory per-key rate limiter.
 *
 * Fixed-window counter (not token bucket): every identifier gets a
 * fresh N-request budget each window. Simple, allocation-light, and
 * fine for a single-instance VPS — which is how forkers of this
 * template will usually deploy.
 *
 * Trade-off: a single Node process holds the Map, so horizontal scale
 * (multiple regions, multiple Hostinger nodes, Vercel serverless fan-
 * out) silently defeats the limit. If you scale beyond one instance,
 * swap the `check` implementation for Redis / Upstash / Cloudflare
 * Durable Objects keeping the same return shape. The call sites won't
 * change.
 *
 * Memory: entries are ~50 bytes each. With LIGHT_SWEEP below, expired
 * keys get cleared opportunistically on every ~200th call (and the
 * Map is hard-capped at MAX_BUCKETS), so a
 * healthy instance stays in the low-MB range even with thousands of
 * distinct users. No background timer — works in serverless edge
 * runtimes that don't keep timers alive across requests.
 */

import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';

export interface RateLimitOptions {
  /** Max requests allowed in `windowMs`. */
  limit: number;
  /** Window size, milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  success: boolean;
  /** Requests still allowed in the current window. */
  remaining: number;
  /** Unix ms when the bucket refills. */
  reset: number;
  limit: number;
}

interface Entry {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Entry>();

// Opportunistic cleanup. Running a sweep on every call would be
// quadratic; running it 1-in-N lets the Map self-drain without a
// background timer.
const LIGHT_SWEEP_EVERY = 200;
let callsSinceSweep = 0;

/** Hard cap on live buckets. Past it the oldest-inserted keys are
 *  evicted (Map iterates in insertion order), so a flood of distinct
 *  keys costs bounded memory instead of growing until the next sweep. */
export const MAX_BUCKETS = 50_000;

/** Keys longer than this are hashed, so a caller-influenced key part
 *  (a token, a header) can't make each Map entry arbitrarily large. */
export const MAX_KEY_LENGTH = 128;

function normalizeKey(key: string): string {
  if (key.length <= MAX_KEY_LENGTH) return key;
  return 'h:' + createHash('sha256').update(key).digest('hex');
}

function sweepExpired(now: number) {
  for (const [k, v] of buckets) {
    if (v.resetAt <= now) buckets.delete(k);
  }
}

function evictOverflow() {
  let excess = buckets.size - MAX_BUCKETS;
  if (excess <= 0) return;
  for (const k of buckets.keys()) {
    buckets.delete(k);
    if (--excess <= 0) break;
  }
}

export function checkRateLimit(
  rawKey: string,
  { limit, windowMs }: RateLimitOptions,
): RateLimitResult {
  const now = Date.now();
  const key = normalizeKey(rawKey);

  callsSinceSweep += 1;
  if (callsSinceSweep >= LIGHT_SWEEP_EVERY) {
    callsSinceSweep = 0;
    sweepExpired(now);
  }

  const entry = buckets.get(key);

  if (!entry || entry.resetAt <= now) {
    // delete-then-set moves a refreshed key to the end of the
    // insertion order, so eviction drops genuinely stale keys first.
    buckets.delete(key);
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    if (buckets.size > MAX_BUCKETS) {
      sweepExpired(now);
      evictOverflow();
    }
    return { success: true, remaining: limit - 1, reset: now + windowMs, limit };
  }

  if (entry.count >= limit) {
    return { success: false, remaining: 0, reset: entry.resetAt, limit };
  }

  entry.count += 1;
  return {
    success: true,
    remaining: limit - entry.count,
    reset: entry.resetAt,
    limit,
  };
}

/**
 * Standard 429 response with the headers clients expect (RFC 6585 +
 * draft-ietf-httpapi-ratelimit-headers). Callers just `return` this.
 */
export function rateLimitResponse(result: RateLimitResult): NextResponse {
  const retryAfterSec = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
  return NextResponse.json(
    {
      error: 'Rate limit exceeded',
      retry_after_seconds: retryAfterSec,
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSec),
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': String(result.remaining),
        'X-RateLimit-Reset': String(Math.ceil(result.reset / 1000)),
      },
    },
  );
}

/** Preconfigured budgets, tweak here not at call sites. */
export const RATE_LIMITS = {
  /** Individual message send. 60/min per user = one per second
   *  sustained, comfortable for a live human typing. */
  send: { limit: 60, windowMs: 60_000 },
  /** Broadcast dispatch. NOT one call per campaign: the wizard fans a
   *  campaign out over `/api/whatsapp/broadcast` in batches of 10
   *  recipients, roughly one call every 1–2 s, so a 1 000-recipient
   *  send is ~100 calls over several minutes. This bucket was 5/min on
   *  the assumption of one call per campaign, which meant everything
   *  past the first ~50 recipients came back 429 and was recorded as a
   *  failed recipient (issue #472). 60/min per user carries the wizard's
   *  pacing with headroom while still bounding a script in a loop;
   *  Meta's own per-number limits remain the real throughput ceiling. */
  broadcast: { limit: 60, windowMs: 60_000 },
  /** Reaction add/swap/remove. More permissive than send — users
   *  fidget with reactions and a single "swap" is actually two calls
   *  (remove + add) under the hood. */
  react: { limit: 120, windowMs: 60_000 },
  /** Invitation peek (public, per-IP). 30/min lets a forwarded link
   *  retry a handful of times under flaky connectivity without
   *  enabling brute-force token enumeration. With 256-bit tokens the
   *  enumeration risk is theoretical; this is belt-and-braces. */
  invitationPeek: { limit: 30, windowMs: 60_000 },
  /** Invitation redeem (authed, per-IP+user). Tighter than peek —
   *  successful redemption mutates two profiles and an invite row, so
   *  the abuse surface is "spam join attempts." */
  invitationRedeem: { limit: 10, windowMs: 60_000 },
  /** Admin-only account / member-management actions: create/revoke
   *  invitation, rename account, change member role, remove member,
   *  transfer ownership. 30/min per user is comfortably above any
   *  realistic legitimate use (the Members tab is a clicks-only UI)
   *  while still bounding accidental abuse from a script run in a
   *  loop or a compromised admin session spamming role flips. */
  adminAction: { limit: 30, windowMs: 60_000 },
  /** Marketing contact form (public, per-IP). 5/min is generous for
   *  a real visitor filling one form and tight enough to blunt a
   *  scripted flood at the unauthenticated /contato endpoint. */
  marketingContact: { limit: 5, windowMs: 60_000 },
  /** CNPJ / CEP lookup (public, per-IP, one bucket per kind). The form
   *  fires one call per completed document, so 60/min is generous for a
   *  human — and for an office behind one NAT address — while still
   *  keeping a scraper from using us as a free Receita proxy. */
  lookup: { limit: 60, windowMs: 60_000 },
  /** Public CNPJ lookup (per-IP). Tighter than CEP: each miss can walk
   *  three upstream sources whose free tiers allow ~3 calls a minute.
   *  Signup / Settings fire one call per completed CNPJ. */
  lookupCnpj: { limit: 20, windowMs: 60_000 },
  /** Authenticated CNPJ lookup from the Empresas form (per user). */
  companyLookup: { limit: 10, windowMs: 60_000 },
  /** Platform gate sign-in / password change (per IP + user). 10/min
   *  leaves room for a few typos while making online guessing of the
   *  master password impractical on top of the CRM login it already
   *  requires. */
  platformGate: { limit: 10, windowMs: 60_000 },
  /** "Sugerir resposta" (per user). Each call spends the account's own
   *  provider credit; 10/min is plenty for an agent clicking the button
   *  and bounds a script hammering someone else's key. */
  aiSuggest: { limit: 10, windowMs: 60_000 },
  /** "Classificar" (per user) — one small model call on the account's own key. */
  aiTriage: { limit: 10, windowMs: 60_000 },
  /** WhatsApp media proxy (per user). Each hit is two Meta calls; an
   *  inbox thread can render dozens of bubbles at once and the browser
   *  caches the result (private, 1 day), so the budget is generous. */
  mediaProxy: { limit: 300, windowMs: 60_000 },
  /** Mark-as-read (per user): fired on every conversation open and
   *  forwards a read receipt to Meta / the QR gateway. */
  markRead: { limit: 120, windowMs: 60_000 },
  /** Manual automation trigger (per user). One call can fan out to
   *  every matching automation's outbound sends. */
  automationTrigger: { limit: 20, windowMs: 60_000 },
  /** Meta webhook verification handshake (public, per IP). Meta calls
   *  it once when the URL is saved; anything more is probing. */
  webhookVerify: { limit: 20, windowMs: 60_000 },
} as const;

/** Test-only helper. Clears the in-memory state so unit tests don't
 *  leak buckets across files. Not wired up in production code. */
export function __resetRateLimitForTests() {
  buckets.clear();
  callsSinceSweep = 0;
}

/** Test-only: number of live buckets. */
export function __rateLimitBucketCountForTests(): number {
  return buckets.size;
}
