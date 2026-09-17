// ============================================================
// /api/account
//
//   GET   — current caller's account + role. Any member.
//   PATCH — rename the account and/or update its pessoa
//           física / jurídica registration.       Admin+.
//
// Why both verbs share a route file
//   They speak about the same singular resource (the caller's
//   account) and reuse the same `requireRole` plumbing. Splitting
//   them across files would duplicate the `account_id` lookup
//   without buying anything.
// ============================================================

import { NextResponse } from "next/server";

import {
  requireRole,
  getCurrentAccount,
  toErrorResponse,
} from "@/lib/auth/account";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import { AUDIT_ACTIONS } from "@/lib/audit";
import { audit } from "@/lib/audit-server";
import {
  MAX_NAME_LEN,
  validateAccountDocument,
  type RegistrationErrors,
} from "@/lib/br/documents";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    return NextResponse.json({
      account: ctx.account,
      role: ctx.role,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Body field → `errors` key in the 400 response (snake_case like the columns). */
const FIELD_KEYS = { personType: "person_type", taxId: "tax_id", legalName: "legal_name" } as const;

function toWireErrors(errors: RegistrationErrors): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, code] of Object.entries(errors)) {
    const key = FIELD_KEYS[field as keyof typeof FIELD_KEYS];
    if (key && code) out[key] = code;
  }
  return out;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole("admin");

    // Per-user limit on admin-class mutations. Bounds accidental
    // abuse (script run in a loop) and a compromised admin session
    // spamming renames. Each admin endpoint keys its own bucket so
    // one route doesn't starve another.
    const limit = checkRateLimit(
      `admin:rename:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as
      | { name?: unknown; person_type?: unknown; tax_id?: unknown; legal_name?: unknown }
      | null;

    const wantsName = body?.name !== undefined;
    // Any registration key means "here is the full registration" —
    // the three fields are validated together because the document
    // format depends on the person type.
    const wantsRegistration =
      body?.person_type !== undefined ||
      body?.tax_id !== undefined ||
      body?.legal_name !== undefined;

    if (!body || (!wantsName && !wantsRegistration)) {
      return NextResponse.json(
        { error: "Nothing to update" },
        { status: 400 },
      );
    }

    const patch: {
      name?: string;
      person_type?: string;
      tax_id?: string;
      legal_name?: string | null;
    } = {};

    if (wantsName) {
      if (typeof body.name !== "string") {
        return NextResponse.json(
          { error: "'name' must be a string" },
          { status: 400 },
        );
      }
      const name = body.name.trim();
      if (name.length === 0) {
        return NextResponse.json(
          { error: "Account name cannot be empty" },
          { status: 400 },
        );
      }
      if (name.length > MAX_NAME_LEN) {
        return NextResponse.json(
          { error: `Account name must be ${MAX_NAME_LEN} characters or fewer` },
          { status: 400 },
        );
      }
      patch.name = name;
    }

    if (wantsRegistration) {
      const doc = validateAccountDocument({
        personType: asString(body.person_type) as never,
        taxId: asString(body.tax_id),
        legalName: asString(body.legal_name),
      });
      if (!doc.ok) {
        return NextResponse.json(
          { error: "Invalid registration data", errors: toWireErrors(doc.errors) },
          { status: 400 },
        );
      }
      patch.person_type = doc.value.personType;
      patch.tax_id = doc.value.taxId;
      patch.legal_name = doc.value.legalName;
    }

    // RLS allows this UPDATE because accounts_update requires
    // `is_account_member(id, 'admin')`, and requireRole already
    // guaranteed the caller is admin+.
    const { data, error } = await ctx.supabase
      .from("accounts")
      .update(patch)
      .eq("id", ctx.accountId)
      .select("id, name, person_type, tax_id, legal_name")
      .single();

    if (error) {
      console.error("[PATCH /api/account] update error:", error);
      return NextResponse.json(
        { error: "Failed to update account" },
        { status: 500 },
      );
    }

    if (patch.name !== undefined && data.name !== ctx.account.name) {
      await audit({
        accountId: ctx.accountId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.ACCOUNT_RENAMED,
        entityType: "account",
        entityId: ctx.accountId,
        metadata: { from: ctx.account.name, to: data.name },
      });
    }

    if (wantsRegistration) {
      const before = {
        person_type: ctx.account.person_type,
        tax_id: ctx.account.tax_id,
        legal_name: ctx.account.legal_name,
      };
      const after = {
        person_type: data.person_type,
        tax_id: data.tax_id,
        legal_name: data.legal_name,
      };
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        await audit({
          accountId: ctx.accountId,
          actorUserId: ctx.userId,
          action: AUDIT_ACTIONS.ACCOUNT_REGISTRATION_UPDATED,
          entityType: "account",
          entityId: ctx.accountId,
          metadata: { from: before, to: after },
        });
      }
    }

    return NextResponse.json({ account: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
