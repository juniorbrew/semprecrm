"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";

import { useLanguage } from "@/hooks/use-language";
import {
  PLAN_LABELS,
  PLAN_STATUSES,
  resolveEntitlements,
  type PlanStatus,
} from "@/lib/plans";
import type { PlatformAccountRow } from "@/types";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { PlanStatusChip, planStatusLabelKey } from "./plan-status-chip";

type StatusFilter = "all" | PlanStatus;

function fmtDate(iso: string | null, locale: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function fmtLimit(value: number | null): string {
  return value === null ? "∞" : String(value);
}

export function PlatformAccountsTable({ rows }: { rows: PlatformAccountRow[] }) {
  const { t, language } = useLanguage();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (status !== "all" && r.plan_status !== status) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        (r.owner_email ?? "").toLowerCase().includes(q) ||
        (r.owner_name ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, query, status]);

  return (
    <section>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {t("Accounts")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {rows.length} {rows.length === 1 ? t("account") : t("accounts")}
            {filtered.length !== rows.length ? (
              <span data-no-translate>
                {" "}· {filtered.length} {t("shown")}
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("Search by name or e-mail")}
              className="h-9 w-full pl-8 sm:w-64"
              aria-label={t("Search accounts")}
            />
          </div>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
            aria-label={t("Filter by status")}
            className="h-9 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          >
            <option value="all">{t("All statuses")}</option>
            {PLAN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(planStatusLabelKey(s))}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-5 overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[880px] text-sm">
          <thead className="bg-muted/50 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-4 py-3">{t("Account")}</th>
              <th className="px-4 py-3">{t("Owner")}</th>
              <th className="px-4 py-3">{t("Plan")}</th>
              <th className="px-4 py-3">{t("Status")}</th>
              <th className="px-4 py-3">{t("Valid until")}</th>
              <th className="px-4 py-3 text-right">{t("Members")}</th>
              <th className="px-4 py-3 text-right">{t("Channels")}</th>
              <th className="px-4 py-3">{t("Created")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-10 text-center text-sm text-muted-foreground"
                >
                  {t("No accounts match the current filters.")}
                </td>
              </tr>
            ) : (
              filtered.map((r) => {
                const ent = resolveEntitlements(r);
                const memberCount = Number(r.members_count);
                const pending = Number(r.pending_invites_count);
                const overMembers =
                  ent.limits.max_users !== null &&
                  memberCount + pending >= ent.limits.max_users;
                return (
                  <tr key={r.id} className="transition-colors hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <Link
                        href={`/platform/${r.id}`}
                        className="font-medium text-foreground underline-offset-4 hover:text-primary hover:underline"
                        data-no-translate
                      >
                        {r.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3" data-no-translate>
                      <div className="text-foreground">{r.owner_name || "—"}</div>
                      <div className="text-xs text-muted-foreground">
                        {r.owner_email ?? "—"}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-foreground">
                      {t(PLAN_LABELS[ent.plan])}
                    </td>
                    <td className="px-4 py-3">
                      <PlanStatusChip status={ent.status} blocked={!!ent.blocked} />
                    </td>
                    <td className="px-4 py-3 text-foreground" data-no-translate>
                      {fmtDate(r.plan_expires_at, language)}
                    </td>
                    <td
                      className={cn(
                        "px-4 py-3 text-right tabular-nums",
                        overMembers ? "text-amber-600 dark:text-amber-300" : "text-foreground",
                      )}
                      data-no-translate
                    >
                      {memberCount}
                      {pending ? `+${pending}` : ""} / {fmtLimit(ent.limits.max_users)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-foreground" data-no-translate>
                      {Number(r.channels_count)} / {fmtLimit(ent.limits.max_channels)}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground" data-no-translate>
                      {fmtDate(r.created_at, language)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
