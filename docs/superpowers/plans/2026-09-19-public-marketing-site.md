# Site público/comercial do SempreCRM — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the public/commercial site for SempreCRM (home + `/precos` + `/contato`), served from the same Next.js app at the same domain, replacing the current `/` → `/dashboard` redirect, with zero risk to the authenticated product.

**Architecture:** A new `(marketing)` route group in `src/app/` with its own header/footer layout, static content sections built from real product data (`src/lib/plans.ts`), a Supabase-backed contact form, GA4 analytics behind an env var, and Next.js file-convention SEO (`sitemap.ts`, `robots.ts`, `opengraph-image.tsx`). No DNS/infra changes.

**Tech Stack:** Next.js 16 App Router (Server Components by default), Tailwind v4 (existing tokens only), shadcn/ui `base-nova` components already in the repo (`button`, `card`, `input`, `label`, `textarea`, `accordion`), Supabase (service-role client for the public write), Vitest.

**Spec:** [docs/superpowers/specs/2026-09-19-public-marketing-site-design.md](../specs/2026-09-19-public-marketing-site-design.md)

## Global Constraints

- Copy is hardcoded pt-BR JSX (matching `(auth)/login` and `(auth)/signup` — the app does **not** wire page copy through `useLanguage()`/`t()`; that's reserved for parameterized validation messages).
- No new UI library or new shadcn component — `accordion.tsx` and `textarea.tsx` already exist in `src/components/ui/`.
- No `zod` — this repo has zero zod usage. Validate manually (`typeof` guards, trim, length caps) and return `NextResponse.json({ error }, { status })`, matching `src/app/api/lead-sources/route.ts` and `src/app/api/account/preferences/route.ts`.
- Every public (unauthenticated) API route is rate-limited by IP via `checkRateLimit`/`rateLimitResponse` from `src/lib/rate-limit.ts`, matching `src/app/api/invitations/[token]/peek/route.ts`.
- Compose a `<Button>`-styled link with `buttonVariants({...})` directly on `<Link>`/`<a>`, never `<Button asChild>` — the app's Button is a Base UI primitive with no `asChild` slot (see `src/components/settings/invite-member-dialog.tsx:241-245`).
- Migrations follow the exact header/idempotency style of `supabase/migrations/042_account_registration.sql` and `029_lead_sources.sql`: `-- ====...====` fenced header comment, `CREATE TABLE IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT`, `uuid_generate_v4()` for ids, closing `Idempotent — safe to run multiple times.` line.
- No values invented: plan modules/limits come straight from `src/lib/plans.ts` (`PLAN_CATALOG`), no R$ pricing, no invented phone number. Contact email is `contato@semprecrm.com.br` — **flag to the user at the end that this must be confirmed as a real, monitored inbox** (it's display text only; nothing sends mail to it).
- `(auth)`, `(dashboard)`, `/platform`, `/api/*` are never modified except the two explicitly listed here (`next.config.ts` CSP, `.env.local.example`, `src/lib/rate-limit.ts`). Root `src/app/layout.tsx` is **not** modified.
- Every task that touches TypeScript must leave `npm run typecheck` and `npm run lint` clean; every task that adds a route must not break `npm run build`.

---

### Task 1: Contact form validation + rate-limit budget (pure logic, TDD)

**Files:**
- Create: `src/lib/marketing/contact.ts`
- Create: `src/lib/marketing/contact.test.ts`
- Modify: `src/lib/rate-limit.ts:116-144` (add a budget to `RATE_LIMITS`)

**Interfaces:**
- Produces: `validateContactSubmission(input: ContactSubmissionInput): ContactValidationResult` and `CONTACT_LIMITS` — consumed by Task 3's route handler. `RATE_LIMITS.marketingContact` — consumed by Task 3.

- [ ] **Step 1: Write the failing test**

Create `src/lib/marketing/contact.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validateContactSubmission } from "./contact";

const BASE = {
  name: "Maria Silva",
  email: "maria@example.com",
  company: "Acme",
  message: "Quero saber mais sobre o plano Empresa.",
  website: "",
};

describe("validateContactSubmission", () => {
  it("accepts a well-formed submission", () => {
    const result = validateContactSubmission(BASE);
    expect(result).toEqual({
      ok: true,
      data: {
        name: "Maria Silva",
        email: "maria@example.com",
        company: "Acme",
        message: "Quero saber mais sobre o plano Empresa.",
      },
    });
  });

  it("treats a filled honeypot field as spam without validating the rest", () => {
    const result = validateContactSubmission({
      ...BASE,
      name: "",
      website: "http://spam.example",
    });
    expect(result).toEqual({ ok: false, error: "spam detected", isSpam: true });
  });

  it("rejects a missing name", () => {
    const result = validateContactSubmission({ ...BASE, name: "" });
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid email", () => {
    const result = validateContactSubmission({ ...BASE, email: "not-an-email" });
    expect(result.ok).toBe(false);
  });

  it("rejects a message over the length limit", () => {
    const result = validateContactSubmission({ ...BASE, message: "a".repeat(2001) });
    expect(result.ok).toBe(false);
  });

  it("treats a blank company as null", () => {
    const result = validateContactSubmission({ ...BASE, company: "   " });
    expect(result).toMatchObject({ ok: true, data: { company: null } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/lib/marketing/contact.test.ts`
Expected: FAIL — `Cannot find module './contact'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/lib/marketing/contact.ts`:

```ts
// ============================================================
// Validation for the public /contato form (POST
// /api/marketing/contact). Pure, no I/O — mirrors the manual-
// validation convention used across the app's API routes (no
// zod in this codebase).
// ============================================================

export const CONTACT_LIMITS = {
  name: 120,
  email: 160,
  company: 120,
  message: 2000,
} as const;

export interface ContactSubmissionInput {
  name: unknown;
  email: unknown;
  company: unknown;
  message: unknown;
  /** Honeypot field — must arrive empty from a real visitor. */
  website: unknown;
}

export interface ContactSubmissionData {
  name: string;
  email: string;
  company: string | null;
  message: string;
}

export type ContactValidationResult =
  | { ok: true; data: ContactSubmissionData }
  | { ok: false; error: string; isSpam?: boolean };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateContactSubmission(
  input: ContactSubmissionInput,
): ContactValidationResult {
  // Honeypot: a real visitor never sees or fills this hidden field.
  // A bot that fills every input does. Report success upstream
  // without writing anything, so the bot can't tell it was rejected.
  const website = typeof input.website === "string" ? input.website.trim() : "";
  if (website.length > 0) {
    return { ok: false, error: "spam detected", isSpam: true };
  }

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return { ok: false, error: "Name is required" };
  if (name.length > CONTACT_LIMITS.name) {
    return { ok: false, error: `Name must be ${CONTACT_LIMITS.name} characters or fewer` };
  }

  const email = typeof input.email === "string" ? input.email.trim() : "";
  if (!email || email.length > CONTACT_LIMITS.email || !EMAIL_RE.test(email)) {
    return { ok: false, error: "A valid email is required" };
  }

  const companyRaw = typeof input.company === "string" ? input.company.trim() : "";
  if (companyRaw.length > CONTACT_LIMITS.company) {
    return { ok: false, error: `Company must be ${CONTACT_LIMITS.company} characters or fewer` };
  }
  const company = companyRaw.length > 0 ? companyRaw : null;

  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!message) return { ok: false, error: "Message is required" };
  if (message.length > CONTACT_LIMITS.message) {
    return { ok: false, error: `Message must be ${CONTACT_LIMITS.message} characters or fewer` };
  }

  return { ok: true, data: { name, email, company, message } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/lib/marketing/contact.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Add the rate-limit budget**

In `src/lib/rate-limit.ts`, inside the `RATE_LIMITS` object (currently lines 116-144, ending with the `adminAction` entry before the closing `} as const;`), add a new entry right after `adminAction`:

```ts
  /** Marketing contact form (public, per-IP). 5/min is generous for
   *  a real visitor filling one form and tight enough to blunt a
   *  scripted flood at the unauthenticated /contato endpoint. */
  marketingContact: { limit: 5, windowMs: 60_000 },
```

So the full object reads (unchanged entries omitted for brevity — only the new key is added, nothing else in the file changes):

```ts
export const RATE_LIMITS = {
  send: { limit: 60, windowMs: 60_000 },
  broadcast: { limit: 5, windowMs: 60_000 },
  react: { limit: 120, windowMs: 60_000 },
  invitationPeek: { limit: 30, windowMs: 60_000 },
  invitationRedeem: { limit: 10, windowMs: 60_000 },
  adminAction: { limit: 30, windowMs: 60_000 },
  marketingContact: { limit: 5, windowMs: 60_000 },
} as const;
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/marketing/contact.ts src/lib/marketing/contact.test.ts src/lib/rate-limit.ts
git commit -m "feat(marketing): add contact form validation and rate-limit budget"
```

---

### Task 2: `contact_submissions` migration

**Files:**
- Create: `supabase/migrations/043_marketing_contact.sql`

**Interfaces:**
- Produces: table `contact_submissions(id, name, email, company, message, source, created_at)`, RLS enabled with **no policies** — consumed by Task 3's service-role insert.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/043_marketing_contact.sql`:

```sql
-- ============================================================
-- 043_marketing_contact.sql — Contact form submissions from the
-- public marketing site (/contato).
--
-- What this migration does
--   1. Creates `contact_submissions` — one row per form
--      submission (name, email, company, message, source). Not
--      tenant-scoped: this table has no `account_id`, it exists
--      outside any customer account, fed only by the
--      unauthenticated POST /api/marketing/contact route.
--   2. RLS: enabled with NO policies — anon and authenticated
--      roles get zero access (select/insert/update/delete all
--      denied). The API route writes exclusively through the
--      service-role client, which bypasses RLS entirely — same
--      model as `lead_source_events` (029): nobody writes
--      through RLS, the route uses the service role.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS contact_submissions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  company     TEXT,
  message     TEXT NOT NULL,
  source      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE contact_submissions DROP CONSTRAINT IF EXISTS contact_submissions_name_check;
ALTER TABLE contact_submissions ADD CONSTRAINT contact_submissions_name_check
  CHECK (length(btrim(name)) > 0);

ALTER TABLE contact_submissions DROP CONSTRAINT IF EXISTS contact_submissions_message_check;
ALTER TABLE contact_submissions ADD CONSTRAINT contact_submissions_message_check
  CHECK (length(btrim(message)) > 0);

CREATE INDEX IF NOT EXISTS idx_contact_submissions_created ON contact_submissions(created_at DESC);

ALTER TABLE contact_submissions ENABLE ROW LEVEL SECURITY;
-- No policies: RLS enabled with zero grants blocks anon and
-- authenticated entirely. Only the service-role client (used by
-- POST /api/marketing/contact) can read or write this table.

COMMENT ON TABLE contact_submissions IS 'Public /contato form submissions. No RLS policies — service role only.';
```

- [ ] **Step 2: Apply the migration locally**

Run: `npx supabase db push`
Expected: migration `043_marketing_contact` applied with no errors. (Per project memory: never run `supabase db reset` — only `db push`.)

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/043_marketing_contact.sql
git commit -m "feat(marketing): add contact_submissions table"
```

---

### Task 3: `POST /api/marketing/contact` route

**Files:**
- Create: `src/app/api/marketing/contact/route.ts`

**Interfaces:**
- Consumes: `validateContactSubmission`, `CONTACT_LIMITS` from `@/lib/marketing/contact` (Task 1); `checkRateLimit`, `rateLimitResponse`, `RATE_LIMITS.marketingContact` from `@/lib/rate-limit` (Task 1); table `contact_submissions` (Task 2); `supabaseServerUrl` from `@/lib/supabase/url`.
- Produces: `POST /api/marketing/contact` — accepts JSON `{ name, email, company, message, website }`, returns `{ ok: true }` (200) on success/honeypot-trip, `{ error: string }` (400/429/500) on failure. Consumed by Task 13's `ContactForm` client component.

- [ ] **Step 1: Write the route handler**

Create `src/app/api/marketing/contact/route.ts`:

```ts
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

import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
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
  if (!limit.success) return rateLimitResponse(limit);

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
```

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 3: Manual smoke test**

Run: `npm run dev`, then in another terminal:

```bash
curl -s -X POST http://localhost:3100/api/marketing/contact \
  -H "Content-Type: application/json" \
  -d '{"name":"Teste","email":"teste@example.com","company":"","message":"Mensagem de teste","website":""}'
```

Expected: `{"ok":true}`. Then confirm the row landed: `npx supabase db execute "select name, email, message from contact_submissions order by created_at desc limit 1;"` (or check via the Supabase Studio table view) shows the test row.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/marketing/contact/route.ts
git commit -m "feat(marketing): add POST /api/marketing/contact route"
```

---

### Task 4: GA4 analytics plumbing (env var, CSP, tracking helper)

**Files:**
- Modify: `.env.local.example` (add `NEXT_PUBLIC_GA_MEASUREMENT_ID`)
- Modify: `next.config.ts:44-63` (CSP `script-src`/`connect-src`)
- Create: `src/lib/analytics.ts`
- Create: `src/app/(marketing)/_components/analytics.tsx`

**Interfaces:**
- Produces: `trackEvent(name: string, params?: Record<string, unknown>): void` from `@/lib/analytics` — consumed by Task 13's `ContactForm`. `<Analytics />` component — consumed by Task 5's `(marketing)/layout.tsx`. Any server-rendered element anywhere in the marketing pages can opt into click tracking with `data-analytics="<event_name>"` — no import needed, `<Analytics />` delegates clicks globally.

- [ ] **Step 1: Add the env var placeholder**

In `.env.local.example`, add near the other `NEXT_PUBLIC_*` vars (after the `NEXT_PUBLIC_SITE_URL=https://crm.example.com` line, i.e. after line 37):

```
# Google Analytics 4 Measurement ID for the public marketing site
# (/, /precos, /contato). Leave empty to disable analytics — the
# marketing layout no-ops silently when this is unset. Never loaded
# on (auth)/(dashboard)/platform routes.
NEXT_PUBLIC_GA_MEASUREMENT_ID=
```

- [ ] **Step 2: Allow GA4's origins in the CSP**

In `next.config.ts`, inside the `Content-Security-Policy-Report-Only` array (lines ~44-63), change these two lines:

```ts
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
```
to:
```ts
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.googletagmanager.com",
```

and:
```ts
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
```
to:
```ts
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://www.google-analytics.com https://*.google-analytics.com https://*.analytics.google.com",
```

Nothing else in `next.config.ts` changes — `img-src 'self' data: blob: https:` already permits any `https:` image source, which covers GA's pixel fallback.

- [ ] **Step 3: Write the tracking helper**

Create `src/lib/analytics.ts`:

```ts
// ============================================================
// Thin wrapper around window.gtag for the marketing site's
// conversion events. No-ops if GA4 isn't loaded (no env var set,
// script blocked, or called from the server) — callers never
// need to check first.
// ============================================================

type Gtag = (...args: unknown[]) => void;

export function trackEvent(name: string, params?: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  const gtag = (window as unknown as { gtag?: Gtag }).gtag;
  if (typeof gtag !== "function") return;
  gtag("event", name, params);
}
```

- [ ] **Step 4: Write the Analytics component**

Create `src/app/(marketing)/_components/analytics.tsx`:

```tsx
"use client";

import { useEffect } from "react";
import Script from "next/script";

import { trackEvent } from "@/lib/analytics";

const GA_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

/**
 * Loads GA4 and wires a document-level click listener so any
 * server-rendered element can opt into tracking with
 * `data-analytics="event_name"` — no need to turn CTAs into client
 * components just to fire an event. No-ops entirely when
 * NEXT_PUBLIC_GA_MEASUREMENT_ID is unset. Mounted once, in
 * (marketing)/layout.tsx — never on (auth)/(dashboard)/platform.
 */
export function Analytics() {
  useEffect(() => {
    if (!GA_ID) return;

    function handleClick(event: MouseEvent) {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(
        "[data-analytics]",
      );
      if (!target?.dataset.analytics) return;
      trackEvent(target.dataset.analytics);
    }

    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  if (!GA_ID) return null;

  return (
    <>
      <Script src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`} strategy="afterInteractive" />
      <Script id="ga4-init" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', '${GA_ID}');
        `}
      </Script>
    </>
  );
}
```

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors. (`<Analytics />` isn't imported anywhere yet — that's Task 5 — so this step only validates these two new files compile.)

- [ ] **Step 6: Commit**

```bash
git add .env.local.example next.config.ts src/lib/analytics.ts "src/app/(marketing)/_components/analytics.tsx"
git commit -m "feat(marketing): add GA4 plumbing behind NEXT_PUBLIC_GA_MEASUREMENT_ID"
```

---

### Task 5: Marketing layout shell (logo, header, mobile nav, footer)

**Files:**
- Create: `src/app/(marketing)/_components/logo.tsx`
- Create: `src/app/(marketing)/_components/mobile-nav.tsx`
- Create: `src/app/(marketing)/_components/site-header.tsx`
- Create: `src/app/(marketing)/_components/site-footer.tsx`
- Create: `src/app/(marketing)/layout.tsx`

**Interfaces:**
- Consumes: `createClient` from `@/lib/supabase/server` (Task 5 only); `buttonVariants`/`Button` from `@/components/ui/button`; `<Analytics />` from Task 4.
- Produces: `<Logo />`, `<SiteHeader />`, `<SiteFooter />` — consumed by this task's own `layout.tsx`, which wraps every page under `(marketing)` (Tasks 11, 12, 13).

- [ ] **Step 1: Logo**

Create `src/app/(marketing)/_components/logo.tsx`:

```tsx
import Link from "next/link";

export function Logo({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      className={`font-heading text-xl font-semibold tracking-tight text-foreground ${className ?? ""}`}
    >
      Sempre<span className="text-primary">CRM</span>
    </Link>
  );
}
```

- [ ] **Step 2: Mobile nav**

Create `src/app/(marketing)/_components/mobile-nav.tsx`:

```tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";

interface NavLink {
  href: string;
  label: string;
}

export function MobileNav({
  links,
  isAuthenticated,
}: {
  links: NavLink[];
  isAuthenticated: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative md:hidden">
      <Button
        variant="ghost"
        size="icon"
        aria-label={open ? "Fechar menu" : "Abrir menu"}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <X /> : <Menu />}
      </Button>
      {open && (
        <div className="absolute inset-x-0 top-full z-50 border-b border-border bg-background px-4 py-4 shadow-lg">
          <nav className="flex flex-col gap-3">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm text-muted-foreground hover:text-foreground"
                onClick={() => setOpen(false)}
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="mt-4 flex flex-col gap-2">
            {isAuthenticated ? (
              <Link
                href="/dashboard"
                className={buttonVariants({ variant: "default" })}
                onClick={() => setOpen(false)}
              >
                Ir para o painel
              </Link>
            ) : (
              <>
                <Link
                  href="/login"
                  data-analytics="cta_login_click"
                  className={buttonVariants({ variant: "outline" })}
                  onClick={() => setOpen(false)}
                >
                  Entrar
                </Link>
                <Link
                  href="/signup"
                  data-analytics="cta_start_click"
                  className={buttonVariants({ variant: "default" })}
                  onClick={() => setOpen(false)}
                >
                  Começar grátis
                </Link>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Site header (auth-aware)**

Create `src/app/(marketing)/_components/site-header.tsx`:

```tsx
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { Logo } from "./logo";
import { MobileNav } from "./mobile-nav";

const NAV_LINKS = [
  { href: "/#funcionalidades", label: "Funcionalidades" },
  { href: "/#como-funciona", label: "Como funciona" },
  { href: "/precos", label: "Preços" },
  { href: "/contato", label: "Contato" },
];

// Async Server Component — checks auth once per request so a
// visitor who's already logged in sees "Ir para o painel" instead
// of "Entrar" / "Começar grátis" on the marketing site.
export async function SiteHeader() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const isAuthenticated = Boolean(user);

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
        <Logo />
        <nav className="hidden items-center gap-6 md:flex">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="hidden items-center gap-2 md:flex">
          {isAuthenticated ? (
            <Link href="/dashboard" className={buttonVariants({ variant: "default" })}>
              Ir para o painel
            </Link>
          ) : (
            <>
              <Link
                href="/login"
                data-analytics="cta_login_click"
                className={buttonVariants({ variant: "ghost" })}
              >
                Entrar
              </Link>
              <Link
                href="/signup"
                data-analytics="cta_start_click"
                className={buttonVariants({ variant: "default" })}
              >
                Começar grátis
              </Link>
            </>
          )}
        </div>
        <MobileNav links={NAV_LINKS} isAuthenticated={isAuthenticated} />
      </div>
    </header>
  );
}
```

- [ ] **Step 4: Site footer**

Create `src/app/(marketing)/_components/site-footer.tsx`:

```tsx
import Link from "next/link";

import { Logo } from "./logo";

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-10 sm:px-6 md:flex-row md:items-start md:justify-between lg:px-8">
        <div className="max-w-sm space-y-2">
          <Logo />
          <p className="text-sm text-muted-foreground">
            CRM para equipes que vendem e atendem pelo WhatsApp.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-3">
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">Produto</p>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>
                <Link href="/#funcionalidades" className="hover:text-foreground">
                  Funcionalidades
                </Link>
              </li>
              <li>
                <Link href="/precos" className="hover:text-foreground">
                  Preços
                </Link>
              </li>
            </ul>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">Conta</p>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>
                <Link href="/login" data-analytics="cta_login_click" className="hover:text-foreground">
                  Entrar
                </Link>
              </li>
              <li>
                <Link href="/signup" data-analytics="cta_start_click" className="hover:text-foreground">
                  Começar grátis
                </Link>
              </li>
            </ul>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">Empresa</p>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>
                <Link href="/contato" className="hover:text-foreground">
                  Contato
                </Link>
              </li>
            </ul>
          </div>
        </div>
      </div>
      <div className="border-t border-border px-4 py-4 text-center text-xs text-muted-foreground sm:px-6 lg:px-8">
        © {new Date().getFullYear()} SempreCRM. Todos os direitos reservados.
      </div>
    </footer>
  );
}
```

- [ ] **Step 5: Marketing layout**

Create `src/app/(marketing)/layout.tsx`:

```tsx
import type { Metadata } from "next";

import { SiteHeader } from "./_components/site-header";
import { SiteFooter } from "./_components/site-footer";
import { Analytics } from "./_components/analytics";

// Overrides the root layout's `robots: { index: false, follow: false }`
// (src/app/layout.tsx:28-31) for every route under this group only.
// Next.js merges metadata per segment — (auth), (dashboard) and
// /platform are untouched and keep inheriting the root's noindex.
export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://www.semprecrm.com.br"),
  robots: {
    index: true,
    follow: true,
  },
};

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
      <Analytics />
    </div>
  );
}
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (The route group has no `page.tsx` yet — that's Task 11 — so `npm run build` isn't expected to fully succeed until then; typecheck alone validates this task.)

- [ ] **Step 7: Commit**

```bash
git add "src/app/(marketing)/_components/logo.tsx" "src/app/(marketing)/_components/mobile-nav.tsx" "src/app/(marketing)/_components/site-header.tsx" "src/app/(marketing)/_components/site-footer.tsx" "src/app/(marketing)/layout.tsx"
git commit -m "feat(marketing): add marketing layout shell (header, footer, mobile nav)"
```

---

### Task 6: SEO file conventions (sitemap, robots, OG image)

**Files:**
- Create: `src/app/sitemap.ts`
- Create: `src/app/robots.ts`
- Create: `src/app/(marketing)/opengraph-image.tsx`

**Interfaces:**
- Produces: `/sitemap.xml`, `/robots.txt`, and the OG image Next.js auto-injects into `(marketing)` pages' `<head>` via `openGraph.images`.

- [ ] **Step 1: Sitemap**

Create `src/app/sitemap.ts`:

```ts
import type { MetadataRoute } from "next";

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.semprecrm.com.br";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return [
    { url: `${BASE_URL}/`, lastModified, changeFrequency: "monthly", priority: 1 },
    { url: `${BASE_URL}/precos`, lastModified, changeFrequency: "monthly", priority: 0.8 },
    { url: `${BASE_URL}/contato`, lastModified, changeFrequency: "yearly", priority: 0.5 },
  ];
}
```

- [ ] **Step 2: Robots**

Create `src/app/robots.ts`:

```ts
import type { MetadataRoute } from "next";

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.semprecrm.com.br";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/precos", "/contato"],
        disallow: [
          "/dashboard",
          "/inbox",
          "/contacts",
          "/pipelines",
          "/tasks",
          "/chat",
          "/agenda",
          "/broadcasts",
          "/automations",
          "/flows",
          "/login",
          "/signup",
          "/forgot-password",
          "/mfa",
          "/join",
          "/platform",
          "/api",
        ],
      },
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
  };
}
```

- [ ] **Step 3: OG image**

Create `src/app/(marketing)/opengraph-image.tsx` (same `ImageResponse` shape as `src/app/icon.tsx` — plain hex colors, Satori can't resolve `oklch()`/CSS vars):

```tsx
import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "SempreCRM — CRM para WhatsApp";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#0d0620",
          color: "#ffffff",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ fontSize: 72, fontWeight: 600 }}>
          Sempre<span style={{ color: "#a78bfa" }}>CRM</span>
        </div>
        <div style={{ marginTop: 24, fontSize: 32, color: "#c4b5fd" }}>
          CRM para equipes que vendem pelo WhatsApp
        </div>
      </div>
    ),
    { ...size },
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/sitemap.ts src/app/robots.ts "src/app/(marketing)/opengraph-image.tsx"
git commit -m "feat(marketing): add sitemap, robots and OG image"
```

---

### Task 7: Hero + Benefits sections

**Files:**
- Create: `src/app/(marketing)/_components/hero.tsx`
- Create: `src/app/(marketing)/_components/benefits.tsx`

**Interfaces:**
- Consumes: `buttonVariants` from `@/components/ui/button`; `Card`, `CardHeader`, `CardTitle`, `CardDescription` from `@/components/ui/card`.
- Produces: `<Hero />`, `<Benefits />` — consumed by Task 11's `page.tsx`.

- [ ] **Step 1: Hero**

Create `src/app/(marketing)/_components/hero.tsx`:

```tsx
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";

export function Hero() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
      <div className="grid gap-10 lg:grid-cols-2 lg:items-center lg:gap-16">
        <div className="space-y-6">
          <span className="inline-flex items-center rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
            CRM para WhatsApp
          </span>
          <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
            O WhatsApp da sua empresa, organizado em um só lugar
          </h1>
          <p className="text-lg text-muted-foreground">
            O SempreCRM reúne a caixa de entrada da sua equipe, o funil de vendas, as tarefas e a
            automação num único sistema — para pequenas e médias empresas que vendem e atendem
            pelo WhatsApp.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/signup"
              data-analytics="cta_start_click"
              className={buttonVariants({ variant: "default", size: "lg", className: "px-6" })}
            >
              Começar grátis
            </Link>
            <Link
              href="/login"
              data-analytics="cta_login_click"
              className={buttonVariants({ variant: "outline", size: "lg", className: "px-6" })}
            >
              Entrar
            </Link>
          </div>
          <p className="text-sm text-muted-foreground">
            Teste grátis por 14 dias. Sem cartão de crédito.
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-2 shadow-2xl shadow-primary/10">
          <div className="rounded-xl border border-border bg-background p-6">
            <div className="mb-4 flex items-center gap-2">
              <span className="size-2.5 rounded-full bg-destructive/60" />
              <span className="size-2.5 rounded-full bg-amber-500/60" />
              <span className="size-2.5 rounded-full bg-emerald-500/60" />
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-lg bg-muted px-3 py-2">
                <span className="text-sm font-medium text-foreground">Caixa de entrada</span>
                <span className="rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground">
                  12 novas
                </span>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-muted px-3 py-2">
                <span className="text-sm font-medium text-foreground">Funil de vendas</span>
                <span className="text-xs text-muted-foreground">8 negócios abertos</span>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-muted px-3 py-2">
                <span className="text-sm font-medium text-foreground">Tarefas de hoje</span>
                <span className="text-xs text-muted-foreground">5 pendentes</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Benefits**

Create `src/app/(marketing)/_components/benefits.tsx`:

```tsx
import { Inbox, Users, GitBranch, ListChecks, Send, Workflow, CalendarClock } from "lucide-react";

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const BENEFITS = [
  {
    icon: Inbox,
    title: "Atenda o WhatsApp em equipe, sem perder conversa",
    description:
      "Uma caixa de entrada compartilhada para toda a equipe, com atribuição de conversas por agente.",
  },
  {
    icon: Users,
    title: "Toda a informação do cliente em um só lugar",
    description: "Contatos com tags e campos personalizados — sem planilha, sem informação espalhada.",
  },
  {
    icon: GitBranch,
    title: "Acompanhe cada oportunidade até fechar",
    description: "Funil de vendas visual (Kanban) ligado direto às conversas do WhatsApp.",
  },
  {
    icon: ListChecks,
    title: "Organize o que sua equipe precisa fazer",
    description: "Tarefas com status personalizáveis, em visão de lista ou de quadro.",
  },
  {
    icon: Send,
    title: "Envie campanhas por WhatsApp",
    description: "Disparos em massa com modelos aprovados pela Meta e acompanhamento de entrega e leitura.",
  },
  {
    icon: Workflow,
    title: "Automatize o repetitivo",
    description: "Fluxos e automações para respostas, tags e etapas do funil, sem precisar programar.",
  },
  {
    icon: CalendarClock,
    title: "Agenda sincronizada",
    description: "Compromissos integrados com Google Calendar e Outlook, para toda a equipe.",
  },
] as const;

export function Benefits() {
  return (
    <section id="beneficios" className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-foreground">
          Tudo que sua equipe precisa para vender e atender pelo WhatsApp
        </h2>
        <p className="mt-3 text-muted-foreground">
          Sem planilhas paralelas, sem WhatsApp Web aberto em dez celulares diferentes.
        </p>
      </div>
      <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {BENEFITS.map((benefit) => (
          <Card key={benefit.title}>
            <CardHeader>
              <benefit.icon className="mb-2 size-6 text-primary" />
              <CardTitle>{benefit.title}</CardTitle>
              <CardDescription>{benefit.description}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(marketing)/_components/hero.tsx" "src/app/(marketing)/_components/benefits.tsx"
git commit -m "feat(marketing): add hero and benefits sections"
```

---

### Task 8: How it works + Features sections

**Files:**
- Create: `src/app/(marketing)/_components/how-it-works.tsx`
- Create: `src/app/(marketing)/_components/features.tsx`

**Interfaces:**
- Produces: `<HowItWorks />` (`id="como-funciona"`), `<Features />` (`id="funcionalidades"`) — consumed by Task 11's `page.tsx`; the header nav (Task 5) links to `/#como-funciona` and `/#funcionalidades`, which resolve to these two ids.

- [ ] **Step 1: How it works**

Create `src/app/(marketing)/_components/how-it-works.tsx`:

```tsx
import { UserPlus, Smartphone, UsersRound, MessageSquareText } from "lucide-react";

const STEPS = [
  {
    icon: UserPlus,
    title: "Crie sua conta",
    description: "Cadastro como pessoa física ou jurídica, em menos de um minuto.",
  },
  {
    icon: Smartphone,
    title: "Configure seu WhatsApp",
    description: "Conecte pela API oficial da Meta ou leia um QR code — você escolhe.",
  },
  {
    icon: UsersRound,
    title: "Convide sua equipe",
    description:
      "Envie um link de convite e defina o papel de cada pessoa (administrador, agente ou visualizador).",
  },
  {
    icon: MessageSquareText,
    title: "Atenda, venda e automatize",
    description: "Sua equipe já começa a trabalhar na caixa de entrada, no funil e nas tarefas.",
  },
] as const;

export function HowItWorks() {
  return (
    <section id="como-funciona" className="border-t border-border bg-muted/40 py-16">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-foreground">Como funciona</h2>
          <p className="mt-3 text-muted-foreground">Do cadastro ao primeiro atendimento, em quatro passos.</p>
        </div>
        <ol className="mt-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, index) => (
            <li key={step.title} className="space-y-3">
              <div className="flex size-10 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                {index + 1}
              </div>
              <step.icon className="size-5 text-primary" />
              <p className="font-medium text-foreground">{step.title}</p>
              <p className="text-sm text-muted-foreground">{step.description}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Features**

Create `src/app/(marketing)/_components/features.tsx`:

```tsx
import { KeyRound, MessageCircle, MessagesSquare, Palette, ShieldCheck, Webhook } from "lucide-react";

const FEATURES = [
  {
    icon: MessageCircle,
    title: "WhatsApp oficial (Meta) ou QR code",
    description:
      "Conecte pela API oficial do WhatsApp Business ou pareie um número existente por QR code — sua escolha, sem travar sua operação.",
  },
  {
    icon: Webhook,
    title: "Captura de leads por webhook",
    description:
      "Receba leads de landing pages, formulários ou automações externas direto no seu funil, já com contato e negócio criados.",
  },
  {
    icon: MessagesSquare,
    title: "Chat interno da equipe",
    description: "Converse com o time sem sair do sistema — separado da caixa de entrada do cliente.",
  },
  {
    icon: Palette,
    title: "Marca própria (white-label)",
    description: "Personalize o nome e o logo do sistema para a sua empresa.",
  },
  {
    icon: ShieldCheck,
    title: "LGPD e trilha de auditoria",
    description: "Ferramentas de conformidade com a LGPD e registro de ações relevantes da conta.",
  },
  {
    icon: KeyRound,
    title: "Autenticação em duas etapas",
    description: "Proteja o acesso da sua conta com verificação em duas etapas (TOTP).",
  },
] as const;

export function Features() {
  return (
    <section id="funcionalidades" className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-foreground">
          Feito para a operação real da sua empresa
        </h2>
        <p className="mt-3 text-muted-foreground">
          Recursos que resolvem detalhes do dia a dia de quem vende e atende pelo WhatsApp no Brasil.
        </p>
      </div>
      <div className="mt-12 grid gap-x-8 gap-y-6 sm:grid-cols-2">
        {FEATURES.map((feature) => (
          <div key={feature.title} className="flex gap-4">
            <feature.icon className="mt-1 size-5 shrink-0 text-primary" />
            <div>
              <p className="font-medium text-foreground">{feature.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{feature.description}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(marketing)/_components/how-it-works.tsx" "src/app/(marketing)/_components/features.tsx"
git commit -m "feat(marketing): add how-it-works and features sections"
```

---

### Task 9: Audience + Demo showcase sections

**Files:**
- Create: `src/app/(marketing)/_components/audience.tsx`
- Create: `src/app/(marketing)/_components/demo-showcase.tsx`

**Interfaces:**
- Produces: `<Audience />`, `<DemoShowcase />` — consumed by Task 11's `page.tsx`.

- [ ] **Step 1: Audience**

Create `src/app/(marketing)/_components/audience.tsx`:

```tsx
import { Briefcase, HeartHandshake, Store } from "lucide-react";

const PROFILES = [
  {
    icon: Store,
    title: "Pequenas e médias empresas",
    description: "Times de vendas e atendimento que hoje dependem só do WhatsApp comum.",
  },
  {
    icon: HeartHandshake,
    title: "Equipes de atendimento e suporte",
    description: "Várias pessoas atendendo o mesmo número, sem perder o histórico da conversa.",
  },
  {
    icon: Briefcase,
    title: "Times comerciais",
    description: "Quem precisa de um funil de vendas simples, ligado direto às conversas.",
  },
] as const;

export function Audience() {
  return (
    <section className="border-t border-border bg-muted/40 py-16">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-foreground">Para quem é o SempreCRM</h2>
          <p className="mt-3 text-muted-foreground">
            Empresas brasileiras de pequeno e médio porte que vendem e atendem pelo WhatsApp.
          </p>
        </div>
        <div className="mt-12 grid gap-6 sm:grid-cols-3">
          {PROFILES.map((profile) => (
            <div key={profile.title} className="rounded-xl border border-border bg-card p-6 text-center">
              <profile.icon className="mx-auto size-8 text-primary" />
              <p className="mt-4 font-medium text-foreground">{profile.title}</p>
              <p className="mt-2 text-sm text-muted-foreground">{profile.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Demo showcase**

Create `src/app/(marketing)/_components/demo-showcase.tsx`:

```tsx
const PIPELINE_STAGES = ["Novo", "Contato feito", "Proposta", "Fechado"] as const;

export function DemoShowcase() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-foreground">Veja como fica na prática</h2>
        <p className="mt-3 text-muted-foreground">Painel, funil e caixa de entrada em um só sistema.</p>
      </div>
      <div className="mt-12 overflow-hidden rounded-2xl border border-border bg-card shadow-2xl shadow-primary/10">
        <div className="flex items-center gap-2 border-b border-border bg-muted/60 px-4 py-3">
          <span className="size-2.5 rounded-full bg-destructive/60" />
          <span className="size-2.5 rounded-full bg-amber-500/60" />
          <span className="size-2.5 rounded-full bg-emerald-500/60" />
          <span className="ml-3 text-xs text-muted-foreground">www.semprecrm.com.br/dashboard</span>
        </div>
        <div className="grid gap-4 p-6 sm:grid-cols-3">
          <div className="rounded-xl bg-muted p-4">
            <p className="text-xs text-muted-foreground">Conversas hoje</p>
            <p className="mt-2 text-2xl font-semibold text-foreground">142</p>
          </div>
          <div className="rounded-xl bg-muted p-4">
            <p className="text-xs text-muted-foreground">Negócios em aberto</p>
            <p className="mt-2 text-2xl font-semibold text-foreground">37</p>
          </div>
          <div className="rounded-xl bg-muted p-4">
            <p className="text-xs text-muted-foreground">Tempo médio de resposta</p>
            <p className="mt-2 text-2xl font-semibold text-foreground">4 min</p>
          </div>
          <div className="col-span-full space-y-2 rounded-xl bg-muted p-4">
            <p className="text-xs text-muted-foreground">Funil de vendas</p>
            <div className="mt-2 flex gap-2">
              {PIPELINE_STAGES.map((stage) => (
                <div key={stage} className="flex-1 rounded-lg bg-background p-3 text-center">
                  <p className="text-xs text-muted-foreground">{stage}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(marketing)/_components/audience.tsx" "src/app/(marketing)/_components/demo-showcase.tsx"
git commit -m "feat(marketing): add audience and demo showcase sections"
```

---

### Task 10: FAQ + final CTA banner

**Files:**
- Create: `src/app/(marketing)/_components/faq.tsx`
- Create: `src/app/(marketing)/_components/cta-banner.tsx`

**Interfaces:**
- Consumes: `Accordion`, `AccordionItem`, `AccordionTrigger`, `AccordionContent` from `@/components/ui/accordion`; `buttonVariants` from `@/components/ui/button`.
- Produces: `<Faq />`, `<CtaBanner />` — consumed by Task 11's `page.tsx`.

- [ ] **Step 1: FAQ**

Create `src/app/(marketing)/_components/faq.tsx`:

```tsx
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

const FAQS = [
  {
    question: "Preciso da API oficial do WhatsApp ou posso usar meu número normal?",
    answer:
      "Os dois funcionam. Você pode conectar pela API oficial do WhatsApp Business (Meta) ou parear um número existente por QR code, como o WhatsApp Web.",
  },
  {
    question: "Dá para convidar minha equipe depois de criar a conta?",
    answer:
      "Sim. Depois de criar a conta, você gera um link de convite e escolhe o papel de cada pessoa (administrador, agente ou visualizador).",
  },
  {
    question: "Meus dados e conversas ficam seguros?",
    answer:
      "Cada conta tem seus dados isolados no banco por regras de segurança em nível de linha (RLS), e o sistema conta com ferramentas de conformidade com a LGPD.",
  },
  {
    question: "Posso testar antes de decidir?",
    answer:
      "Sim, o teste é gratuito por 14 dias e dá acesso a todos os módulos do sistema, sem precisar de cartão de crédito.",
  },
  {
    question: "O que acontece quando o teste grátis termina?",
    answer:
      "Fale com a nossa equipe para escolher o plano ideal para o tamanho da sua operação — Básico, Pro ou Empresa.",
  },
] as const;

export function Faq() {
  return (
    <section className="border-t border-border py-16">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
        <h2 className="text-center text-3xl font-semibold tracking-tight text-foreground">
          Perguntas frequentes
        </h2>
        <Accordion className="mt-10">
          {FAQS.map((faq, index) => (
            <AccordionItem key={faq.question} value={String(index)}>
              <AccordionTrigger>{faq.question}</AccordionTrigger>
              <AccordionContent>
                <p className="text-muted-foreground">{faq.answer}</p>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: CTA banner**

Create `src/app/(marketing)/_components/cta-banner.tsx`:

```tsx
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";

export function CtaBanner() {
  return (
    <section className="border-t border-border bg-primary/5 py-16">
      <div className="mx-auto max-w-3xl px-4 text-center sm:px-6 lg:px-8">
        <h2 className="text-3xl font-semibold tracking-tight text-foreground">
          Pronto para organizar o WhatsApp da sua empresa?
        </h2>
        <p className="mt-3 text-muted-foreground">
          Crie sua conta gratuita em menos de um minuto. Sem cartão de crédito.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/signup"
            data-analytics="cta_start_click"
            className={buttonVariants({ variant: "default", size: "lg", className: "px-6" })}
          >
            Começar grátis
          </Link>
          <Link
            href="/contato"
            className={buttonVariants({ variant: "outline", size: "lg", className: "px-6" })}
          >
            Falar com nossa equipe
          </Link>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(marketing)/_components/faq.tsx" "src/app/(marketing)/_components/cta-banner.tsx"
git commit -m "feat(marketing): add FAQ and CTA banner sections"
```

---

### Task 11: Home page — assemble sections, retire the old root redirect

**Files:**
- Create: `src/app/(marketing)/page.tsx`
- Delete: `src/app/page.tsx`

**Interfaces:**
- Consumes: `<Hero />`, `<Benefits />` (Task 7); `<HowItWorks />`, `<Features />` (Task 8); `<Audience />`, `<DemoShowcase />` (Task 9); `<Faq />`, `<CtaBanner />` (Task 10). All rendered inside `(marketing)/layout.tsx` (Task 5).
- Produces: `GET /` serving the marketing home instead of redirecting to `/dashboard`.

- [ ] **Step 1: Delete the old redirect**

`src/app/page.tsx` currently contains only:

```tsx
import { redirect } from 'next/navigation'

export default function RootPage() {
  redirect('/dashboard')
}
```

Delete this file — Next.js will error with "duplicate page" if both `src/app/page.tsx` and `src/app/(marketing)/page.tsx` resolve to `/` at once, since route groups don't add a URL segment.

```bash
rm "src/app/page.tsx"
```

- [ ] **Step 2: Create the home page**

Create `src/app/(marketing)/page.tsx`:

```tsx
import type { Metadata } from "next";

import { Hero } from "./_components/hero";
import { Benefits } from "./_components/benefits";
import { HowItWorks } from "./_components/how-it-works";
import { Features } from "./_components/features";
import { Audience } from "./_components/audience";
import { DemoShowcase } from "./_components/demo-showcase";
import { Faq } from "./_components/faq";
import { CtaBanner } from "./_components/cta-banner";

export const metadata: Metadata = {
  title: "CRM para WhatsApp que sua equipe vai usar de verdade",
  description:
    "SempreCRM centraliza o WhatsApp da sua empresa: caixa de entrada compartilhada, funil de vendas, tarefas e automação em um só lugar.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "SempreCRM — CRM para WhatsApp",
    description:
      "Centralize o WhatsApp da sua empresa: caixa de entrada compartilhada, funil de vendas, tarefas e automação.",
    url: "/",
    type: "website",
  },
};

export default function HomePage() {
  return (
    <>
      <Hero />
      <Benefits />
      <HowItWorks />
      <Features />
      <Audience />
      <DemoShowcase />
      <Faq />
      <CtaBanner />
    </>
  );
}
```

- [ ] **Step 3: Full build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: build succeeds; the route list printed by `next build` shows `/` (marketing), `/precos` and `/contato` do not exist yet (Tasks 12–13) — that's expected at this point, `/` alone is enough to verify the redirect was correctly replaced.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(marketing)/page.tsx"
git rm src/app/page.tsx
git commit -m "feat(marketing): serve the marketing home at / instead of redirecting to /dashboard"
```

---

### Task 12: `/precos` page

**Files:**
- Create: `src/app/(marketing)/precos/page.tsx`

**Interfaces:**
- Consumes: `PLAN_CATALOG`, `PLAN_LABELS`, `type Plan`, `type Module` from `@/lib/plans` (existing, unmodified); `Card`/`CardHeader`/`CardTitle`/`CardDescription`/`CardContent`/`CardFooter` from `@/components/ui/card`; `buttonVariants` from `@/components/ui/button`.
- Produces: `GET /precos` — linked from Task 5's header nav and Task 10's `CtaBanner`/FAQ answers.

- [ ] **Step 1: Write the page**

Create `src/app/(marketing)/precos/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { Check } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { PLAN_CATALOG, PLAN_LABELS, type Module, type Plan } from "@/lib/plans";

export const metadata: Metadata = {
  title: "Preços",
  description:
    "Planos do SempreCRM: recursos e limites de cada plano. Teste grátis por 14 dias, sem cartão de crédito.",
  alternates: { canonical: "/precos" },
};

const PLAN_ORDER: Plan[] = ["trial", "basico", "pro", "empresa"];

const PLAN_TAGLINES: Record<Plan, string> = {
  trial: "Para testar tudo antes de decidir.",
  basico: "Para começar a organizar o essencial.",
  pro: "Para equipes que já vivem no funil e na automação.",
  empresa: "Para operações maiores, com múltiplos canais.",
};

// pt-BR labels for the marketing site — src/lib/plans.ts's own
// MODULE_LABELS are English (they feed the in-app i18n catalogue),
// but marketing copy is hardcoded pt-BR (see plan's Global
// Constraints), so this page keeps its own translation, matching
// the real sidebar nav labels (src/components/layout/sidebar.tsx).
const MODULE_LABELS_PT: Record<Module, string> = {
  inbox: "Caixa de entrada",
  contacts: "Contatos",
  dashboard: "Painel",
  pipelines: "Funis",
  tasks: "Tarefas",
  broadcasts: "Disparos",
  automations: "Automações",
  flows: "Fluxos",
  channel_official: "WhatsApp oficial (Meta)",
  channel_qr: "WhatsApp via QR code",
  lead_capture: "Captura de leads",
  white_label: "Marca própria",
  internal_chat: "Chat interno",
  calendar: "Agenda",
};

function formatLimit(value: number | null): string {
  return value === null ? "Ilimitado" : String(value);
}

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="text-4xl font-semibold tracking-tight text-foreground">Planos</h1>
        <p className="mt-3 text-muted-foreground">
          Comece com 14 dias de teste grátis, com acesso a todos os módulos. Fale com a nossa
          equipe para saber qual plano cabe melhor no tamanho da sua operação.
        </p>
      </div>
      <div className="mt-12 grid gap-6 lg:grid-cols-4">
        {PLAN_ORDER.map((plan) => {
          const definition = PLAN_CATALOG[plan];
          const isEmpresa = plan === "empresa";
          return (
            <Card key={plan} className={isEmpresa ? "ring-2 ring-primary" : undefined}>
              <CardHeader>
                <CardTitle className="text-lg">{PLAN_LABELS[plan]}</CardTitle>
                <CardDescription>{PLAN_TAGLINES[plan]}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1 text-sm text-foreground">
                  <p>
                    <strong>{formatLimit(definition.limits.max_users)}</strong> usuário(s)
                  </p>
                  <p>
                    <strong>{formatLimit(definition.limits.max_channels)}</strong> canal(is) de WhatsApp
                  </p>
                </div>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  {definition.modules.map((moduleKey) => (
                    <li key={moduleKey} className="flex items-center gap-2">
                      <Check className="size-4 shrink-0 text-primary" />
                      {MODULE_LABELS_PT[moduleKey]}
                    </li>
                  ))}
                </ul>
              </CardContent>
              <CardFooter>
                <Link
                  href={isEmpresa ? "/contato" : "/signup"}
                  data-analytics={isEmpresa ? undefined : "cta_start_click"}
                  className={buttonVariants({
                    variant: isEmpresa ? "outline" : "default",
                    className: "w-full",
                  })}
                >
                  {isEmpresa ? "Falar com nossa equipe" : "Começar grátis"}
                </Link>
              </CardFooter>
            </Card>
          );
        })}
      </div>
      <p className="mt-8 text-center text-sm text-muted-foreground">
        Caixa de entrada e Contatos estão disponíveis em todos os planos.
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors — in particular, `MODULE_LABELS_PT` must satisfy `Record<Module, string>` for all 14 keys in `MODULES` (`src/lib/plans.ts:33-48`); a missing key fails the build.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(marketing)/precos/page.tsx"
git commit -m "feat(marketing): add /precos page with real plan data"
```

---

### Task 13: `/contato` page + contact form

**Files:**
- Create: `src/app/(marketing)/_components/contact-form.tsx`
- Create: `src/app/(marketing)/contato/page.tsx`

**Interfaces:**
- Consumes: `POST /api/marketing/contact` (Task 3); `trackEvent` from `@/lib/analytics` (Task 4); `Button`, `Input`, `Label`, `Textarea` from `@/components/ui/*`; `toast` from `sonner` (already a dependency, `ThemedToaster` is mounted in the root layout so it's available on marketing pages too).
- Produces: `GET /contato`, `<ContactForm />` — closes the loop opened by every `/contato` link in Tasks 5, 10, 12.

- [ ] **Step 1: Contact form (client component)**

Create `src/app/(marketing)/_components/contact-form.tsx`:

```tsx
"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { trackEvent } from "@/lib/analytics";
import { CONTACT_LIMITS } from "@/lib/marketing/contact";

export function ContactForm() {
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);

    const name = String(formData.get("name") ?? "").trim();
    const email = String(formData.get("email") ?? "").trim();
    const company = String(formData.get("company") ?? "").trim();
    const message = String(formData.get("message") ?? "").trim();
    const website = String(formData.get("website") ?? "").trim();

    if (!name || !email || !message) {
      toast.error("Preencha nome, e-mail e mensagem.");
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/marketing/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, company, message, website }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        toast.error(body?.error ?? "Não foi possível enviar sua mensagem. Tente novamente.");
        return;
      }

      trackEvent("contact_form_submit");
      setSent(true);
      form.reset();
    } catch {
      toast.error("Não foi possível enviar sua mensagem. Verifique sua conexão e tente novamente.");
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 text-center">
        <p className="font-medium text-foreground">Mensagem enviada!</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Recebemos sua mensagem e vamos responder pelo e-mail informado.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Honeypot: hidden from sighted users and screen readers alike
          (off-screen, not display:none, so a bot's DOM-based fill still
          catches it) — a real visitor never fills this. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="website">Deixe este campo em branco</label>
        <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="name">Nome</Label>
        <Input id="name" name="name" required maxLength={CONTACT_LIMITS.name} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="email">E-mail</Label>
        <Input id="email" name="email" type="email" required maxLength={CONTACT_LIMITS.email} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="company">Empresa</Label>
        <Input id="company" name="company" maxLength={CONTACT_LIMITS.company} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="message">Mensagem</Label>
        <Textarea id="message" name="message" required maxLength={CONTACT_LIMITS.message} rows={5} />
      </div>
      <Button type="submit" disabled={submitting} className="w-full">
        {submitting ? "Enviando..." : "Enviar mensagem"}
      </Button>
    </form>
  );
}
```

- [ ] **Step 2: Contact page**

Create `src/app/(marketing)/contato/page.tsx`:

```tsx
import type { Metadata } from "next";
import { Mail } from "lucide-react";

import { ContactForm } from "../_components/contact-form";

export const metadata: Metadata = {
  title: "Contato",
  description: "Fale com a equipe do SempreCRM. Tire suas dúvidas antes de começar ou fale sobre o plano Empresa.",
  alternates: { canonical: "/contato" },
};

export default function ContactPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 lg:px-8">
      <div className="text-center">
        <h1 className="text-4xl font-semibold tracking-tight text-foreground">Fale com a gente</h1>
        <p className="mt-3 text-muted-foreground">
          Dúvidas sobre o produto, sobre o plano Empresa ou qualquer outra coisa — é só mandar uma
          mensagem.
        </p>
      </div>
      <div className="mt-10 grid gap-10 sm:grid-cols-[1fr_1.4fr]">
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <Mail className="mt-0.5 size-5 shrink-0 text-primary" />
            <div>
              <p className="font-medium text-foreground">E-mail</p>
              <p className="text-sm text-muted-foreground">contato@semprecrm.com.br</p>
            </div>
          </div>
        </div>
        <ContactForm />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Full build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: build succeeds; route list shows `/`, `/precos`, `/contato`.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(marketing)/_components/contact-form.tsx" "src/app/(marketing)/contato/page.tsx"
git commit -m "feat(marketing): add /contato page with working contact form"
```

---

### Task 14: Full QA pass — browser verification, screenshots, final report

**Files:** none created — verification only, plus opportunistic screenshot capture into `public/marketing/` if the local stack is reachable.

**Interfaces:** N/A — this task exercises every interface produced by Tasks 1–13 end-to-end.

- [ ] **Step 1: Automated checks**

Run, in order, stopping to fix anything that fails before moving on:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

Expected: all four pass clean. `npm run test` should show the 6 tests from Task 1 passing (plus every pre-existing test, untouched).

- [ ] **Step 2: Start the app and open the marketing pages**

Run: `npm run dev` (or the project's Docker dev stack per local conventions), then use the browser tool to open `http://localhost:3100/`.

Check with `read_page`/`get_page_text`:
- Home renders Hero, Benefits, How it works, Features, Audience, Demo, FAQ, CTA banner, header, footer.
- `read_console_messages` shows no errors.
- `read_network_requests` shows no unexpected 4xx/5xx.

- [ ] **Step 3: Click through every CTA and link**

Using `computer`/`find`:
- Header "Começar grátis" → lands on `/signup`.
- Header "Entrar" → lands on `/login`.
- Header nav "Preços" → `/precos`; "Contato" → `/contato`.
- Header nav "Funcionalidades"/"Como funciona" → scrolls to the matching `#funcionalidades`/`#como-funciona` anchor on `/`.
- Footer links all resolve (no 404s).
- On `/precos`, each plan's CTA points where expected (Trial/Básico/Pro → `/signup`, Empresa → `/contato`).

- [ ] **Step 4: Submit the contact form end-to-end**

On `/contato`, fill Nome/E-mail/Mensagem with real-looking test values, submit, and confirm:
- The success state ("Mensagem enviada!") renders.
- `read_network_requests` shows `POST /api/marketing/contact` → 200.
- The row landed: `npx supabase db execute "select name, email from contact_submissions order by created_at desc limit 1;"` shows the submitted values.
- Submitting a 6th time within a minute returns 429 (rate limit from Task 1/3 working) — verify via `read_network_requests`, then wait for the window to reset before continuing.

- [ ] **Step 5: Responsive check**

Use `resize_window` with `preset: "mobile"` (375×812) and `preset: "tablet"` (768×1024), reload each page (`/`, `/precos`, `/contato`), and confirm:
- The mobile nav hamburger opens/closes and its links work.
- No horizontal scroll, no overlapping text, cards stack to one column at 375px.
- Reset with `preset: "desktop"` when done.

- [ ] **Step 6: SEO/meta checks**

- `GET /sitemap.xml` and `GET /robots.txt` return the content from Task 6, with `Allow: /`, `/precos`, `/contato` and `Disallow` on the protected routes.
- View source (or `read_page`) on `/`, `/precos`, `/contato` confirms each `<title>` matches its page's `metadata.title` (with the `— SempreCRM` suffix from the root layout's template) and a distinct `<meta name="description">`.
- Confirm `(auth)/login` and `/dashboard` (if reachable) still carry `noindex` — unaffected by this change (spot-check via `read_page` on `/login`'s `<head>`).

- [ ] **Step 7: Accessibility spot-check**

- Tab through the header, hero CTAs, and the contact form using keyboard only (`key` action with `Tab`/`Shift+Tab`/`Enter`) — every interactive element must show a visible focus ring and be reachable in a sane order.
- Confirm every `<Input>`/`<Textarea>` on `/contato` has an associated `<Label htmlFor>` (already true by construction in Task 13 — verify in the rendered DOM via `read_page`).

- [ ] **Step 8: Attempt real screenshots for Features/Demo (best-effort)**

If the local Supabase/dev stack is reachable and a throwaway trial account can be created via `/signup` without touching any existing customer data: sign up a disposable test account, capture screenshots of `/dashboard` and `/inbox` with the browser tool, save them under `public/marketing/`, and swap them into `DemoShowcase` (Task 9) via `next/image` in place of (or alongside) the stylized composition. This is optional — if the local stack isn't easily reachable in this session, ship with the stylized composition (it already uses real module names and the product's real design tokens, not a generic AI mockup) and note it as a follow-up in the final report.

- [ ] **Step 9: Capture deliverable screenshots**

Using the browser tool, capture and save (to the scratchpad directory) full-page screenshots of `/`, `/precos`, `/contato` at desktop width and at 375px mobile width — six images total — for the final report.

- [ ] **Step 10: Write the final report**

Summarize for the user (in chat, not a new file unless asked): files created/modified (list from Tasks 1–13), commands run, test results, the six screenshots (send via the file-sending tool), a one-paragraph performance/SEO/accessibility note from the manual checks above, the list of tested URLs, and the still-open items requiring the user's input:
- Real GA4 Measurement ID (site ships with analytics disabled until `NEXT_PUBLIC_GA_MEASUREMENT_ID` is set in production).
- Confirm `contato@semprecrm.com.br` is a real, monitored inbox (it's static display text; nothing currently sends mail to it — submissions land in `contact_submissions`, not that inbox).
- Whether to add a `/platform`-side view of `contact_submissions` later (explicitly out of scope here).
- Real pricing (R$) whenever it's defined — the `/precos` page is structured so adding prices later doesn't require rebuilding it.

- [ ] **Step 11: Final commit (if Step 8 changed anything)**

```bash
git add -A
git commit -m "feat(marketing): swap in real product screenshots where captured"
```

(Skip this step entirely if Step 8 made no changes.)
