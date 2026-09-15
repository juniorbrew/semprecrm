"use client";

import { CalendarClock, Check, CreditCard, Minus } from "lucide-react";

import { useAuth, useEntitlements } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import {
  LIMIT_KEYS,
  LIMIT_LABELS,
  MODULES,
  MODULE_LABELS,
  PLAN_LABELS,
  PLAN_STATUS_LABELS,
  daysUntil,
  type PlanStatus,
} from "@/lib/plans";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SettingsPanelHead } from "./settings-panel-head";
import { SettingsChip, type ChipVariant } from "./settings-chip";

const STATUS_VARIANT: Record<PlanStatus, ChipVariant> = {
  trial: "admin",
  active: "ok",
  past_due: "warn",
  canceled: "muted",
  suspended: "warn",
};

/**
 * Read-only view of the account's plan: which plan, its status and
 * expiry, the modules it turns on, and the limits. Reachable even
 * when the account is blocked (the blocked screen links here) so
 * the owner can see *why* and who to contact.
 *
 * Nothing is editable from the customer side — plan changes go
 * through the platform admin (`/platform`) today and a checkout
 * webhook later.
 */
export function PlanPanel() {
  const { t, language } = useLanguage();
  const { profileLoading } = useAuth();
  const ent = useEntitlements();

  const days = daysUntil(ent.expiresAt);
  const expiresLabel = ent.expiresAt
    ? new Date(ent.expiresAt).toLocaleDateString(language, {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : null;

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t("Plan")}
        description={t(
          "What your account includes today. To change the plan or add modules, get in touch with the SempreCRM team.",
        )}
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <CreditCard className="size-4 text-primary" />
            {t("Current plan")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("Plan, status and validity for this account.")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {profileLoading ? (
            <div className="h-16 animate-pulse rounded-lg bg-muted" />
          ) : (
            <dl className="grid gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {t("Plan")}
                </dt>
                <dd className="mt-1 text-base font-semibold text-foreground">
                  {t(PLAN_LABELS[ent.plan])}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {t("Status")}
                </dt>
                <dd className="mt-1">
                  <SettingsChip variant={STATUS_VARIANT[ent.status]}>
                    {t(PLAN_STATUS_LABELS[ent.status])}
                  </SettingsChip>
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {ent.status === "trial" ? t("Trial ends") : t("Valid until")}
                </dt>
                <dd className="mt-1 flex items-center gap-1.5 text-sm text-foreground">
                  <CalendarClock className="size-4 text-muted-foreground" />
                  {expiresLabel ? (
                    <span data-no-translate>
                      {expiresLabel}
                      {days !== null && days >= 0 ? (
                        <span className="text-muted-foreground">
                          {" "}
                          · {days} {days === 1 ? t("day") : t("days")}
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{t("No expiry")}</span>
                  )}
                </dd>
              </div>
            </dl>
          )}
          {ent.blocked ? (
            <p className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              {t("Access to the app is currently blocked. Contact support to restore it.")}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-foreground">{t("Modules")}</CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("Inbox and Contacts are always included.")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2 sm:grid-cols-2">
            {MODULES.map((m) => {
              const on = ent.modules[m];
              return (
                <li
                  key={m}
                  className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"
                >
                  {on ? (
                    <Check className="size-4 text-emerald-500" aria-hidden="true" />
                  ) : (
                    <Minus className="size-4 text-muted-foreground" aria-hidden="true" />
                  )}
                  <span className={on ? "text-foreground" : "text-muted-foreground"}>
                    {t(MODULE_LABELS[m])}
                  </span>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-foreground">{t("Limits")}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2">
            {LIMIT_KEYS.map((k) => (
              <div key={k}>
                <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {t(LIMIT_LABELS[k])}
                </dt>
                <dd className="mt-1 text-base font-semibold text-foreground">
                  {ent.limits[k] === null ? t("Unlimited") : ent.limits[k]}
                </dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
    </section>
  );
}
