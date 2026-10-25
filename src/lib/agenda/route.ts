// ============================================================
// Shared plumbing for /api/agenda/* routes.
//
// Access: scheduling is part of the existing `calendar` plan module
// (no new module). `requireModule` also refuses read-only / blocked
// accounts (402) on every write; reads pass `allowReadOnly`.
// The account always comes from the session, never from the request.
// ============================================================

import { NextResponse } from 'next/server';
import { ZodError, type ZodType } from 'zod';

import {
  requireModule,
  requireRole,
  toErrorResponse,
  type AccountContext,
} from '@/lib/auth/account';
import type { AccountRole } from '@/lib/auth/roles';

import { supabaseAdmin } from '@/lib/automations/admin-client';

import { AgendaError, isAgendaError } from './errors';

/**
 * Client for the booking RPCs. They are executable by service_role only (096):
 * the route has already authenticated the session, checked role / module /
 * writable account, and takes the account from the session.
 */
export function agendaWriter() {
  return supabaseAdmin();
}

/** Session + role + `calendar` module. `write` also refuses read-only accounts. */
export async function agendaContext(min: AccountRole, write: boolean): Promise<AccountContext> {
  const ctx = await requireRole(min);
  await requireModule(ctx, 'calendar', { allowReadOnly: !write });
  return ctx;
}

export function agendaErrorResponse(err: unknown): NextResponse {
  if (isAgendaError(err)) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const where = first?.path.length ? ` (${first.path.join('.')})` : '';
    return NextResponse.json(
      { error: `Dados inválidos${where}.`, code: 'validation' },
      { status: 400 },
    );
  }
  return toErrorResponse(err);
}

/** Parse a JSON body with a zod schema; malformed JSON is a validation error. */
export async function parseBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AgendaError('validation', 'Corpo da requisição inválido.');
  }
  return schema.parse(raw);
}
