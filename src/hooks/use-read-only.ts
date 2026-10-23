"use client";

import { useAuth } from "@/hooks/use-auth";
import { readOnlyReason, type ReadOnlyReason } from "@/lib/billing/read-only";

/**
 * Whether the account is in read-only mode (trial ended or payment
 * overdue) — the client twin of the server's `requireWritable`, built on
 * the same `readOnlyReason`. A platform suspension is NOT read-only: that
 * keeps the full blocked screen.
 */
export function useReadOnly(): {
  readOnly: boolean;
  reason: ReadOnlyReason | null;
  isOwner: boolean;
} {
  const { entitlements, profileLoading, isOwner } = useAuth();
  const reason = profileLoading ? null : readOnlyReason(entitlements);
  return { readOnly: reason !== null, reason, isOwner };
}
