// Shared error → response mapping for the AI routes (server only).

import { NextResponse } from 'next/server';

import { ModuleNotIncludedError, toErrorResponse } from '@/lib/auth/account';
import { AI_ERROR_MESSAGES, AiError } from './errors';

export function aiErrorResponse(err: unknown): NextResponse {
  if (err instanceof AiError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  if (err instanceof ModuleNotIncludedError) {
    return NextResponse.json(
      { error: AI_ERROR_MESSAGES.module_not_included, code: 'module_not_included' },
      { status: 403 },
    );
  }
  return toErrorResponse(err);
}
