"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Ban, CheckCircle2, Loader2, Save } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useLanguage } from "@/hooks/use-language";
import {
  LIMIT_KEYS,
  LIMIT_LABELS,
  MODULE_LABELS,
  OPTIONAL_MODULES,
  PLANS,
  PLAN_CATALOG,
  PLAN_LABELS,
  PLAN_STATUSES,
  PLAN_STATUS_LABELS,
  resolveEntitlements,
  type LimitKey,
  type OptionalModule,
  type Plan,
  type PlanStatus,
} from "@/lib/plans";
import type { PlatformAccountRow } from "@/types";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { PlanStatusChip } from "./plan-status-chip";

// ------------------------------------------------------------
// Local <-> ISO helpers for the datetime-local input.
// ------------------------------------------------------------

function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function addDaysLocalInput(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return isoToLocalInput(d.toISOString());
}

type ModuleChoice = "inherit" | "on" | "off";
type LimitChoice = "inherit" | "unlimited" | "custom";

interface LimitState {
  choice: LimitChoice;
  custom: string;
}

const selectClass =
  "h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60";

function initialModules(row: PlatformAccountRow): Record<OptionalModule, ModuleChoice> {
  const out = {} as Record<OptionalModule, ModuleChoice>;
  for (const m of OPTIONAL_MODULES) {
    const v = row.module_overrides?.[m];
    out[m] = v === true ? "on" : v === false ? "off" : "inherit";
  }
  return out;
}

function initialLimits(row: PlatformAccountRow): Record<LimitKey, LimitState> {
  const out = {} as Record<LimitKey, LimitState>;
  for (const k of LIMIT_KEYS) {
    const has = row.limit_overrides && Object.prototype.hasOwnProperty.call(row.limit_overrides, k);
    const v = has ? row.limit_overrides[k] : undefined;
    if (!has) out[k] = { choice: "inherit", custom: "" };
    else if (v === null) out[k] = { choice: "unlimited", custom: "" };
    else out[k] = { choice: "custom", custom: String(v) };
  }
  return out;
}

export function PlatformAccountForm({ row }: { row: PlatformAccountRow }) {
  const router = useRouter();
  const { t, language } = useLanguage();

  const [plan, setPlan] = useState<Plan>(row.plan);
  const [status, setStatus] = useState<PlanStatus>(row.plan_status);
  const [expires, setExpires] = useState(isoToLocalInput(row.plan_expires_at));
  const [modules, setModules] = useState(() => initialModules(row));
  const [limits, setLimits] = useState(() => initialLimits(row));
  const [notes, setNotes] = useState(row.platform_notes ?? "");
  const [saving, setSaving] = useState(false);
  const [quick, setQuick] = useState<"suspend" | "reactivate" | null>(null);

  const planDef = PLAN_CATALOG[plan];

  // Live preview of what the customer will get with the current
  // (unsaved) form values — same resolver the app uses.
  const preview = useMemo(() => {
    const module_overrides: Record<string, boolean> = {};
    for (const m of OPTIONAL_MODULES) {
      if (modules[m] === "on") module_overrides[m] = true;
      if (modules[m] === "off") module_overrides[m] = false;
    }
    const limit_overrides: Record<string, number | null> = {};
    for (const k of LIMIT_KEYS) {
      const l = limits[k];
      if (l.choice === "unlimited") limit_overrides[k] = null;
      if (l.choice === "custom" && l.custom.trim() !== "") {
        const n = Number(l.custom);
        if (Number.isFinite(n) && n >= 0) limit_overrides[k] = Math.floor(n);
      }
    }
    return {
      patch: {
        plan,
        plan_status: status,
        plan_expires_at: localInputToIso(expires),
        module_overrides,
        limit_overrides,
        platform_notes: notes.trim() === "" ? null : notes.trim(),
      },
      entitlements: resolveEntitlements({
        plan,
        plan_status: status,
        plan_expires_at: localInputToIso(expires),
        module_overrides,
        limit_overrides,
      }),
    };
  }, [plan, status, expires, modules, limits, notes]);

  async function applyPatch(patch: Record<string, unknown>, successMessage: string) {
    const supabase = createClient();
    const { error } = await supabase.rpc("platform_update_account", {
      p_account_id: row.id,
      p_patch: patch,
    });
    if (error) {
      toast.error(`${t("Failed to save")}: ${error.message}`);
      return false;
    }
    toast.success(successMessage);
    router.refresh();
    return true;
  }

  async function handleSave() {
    for (const k of LIMIT_KEYS) {
      const l = limits[k];
      if (l.choice === "custom") {
        const n = Number(l.custom);
        if (l.custom.trim() === "" || !Number.isFinite(n) || n < 0) {
          toast.error(t("Custom limits must be a number of 0 or more."));
          return;
        }
      }
    }
    setSaving(true);
    await applyPatch(preview.patch, t("Account updated"));
    setSaving(false);
  }

  async function handleSuspend() {
    setQuick("suspend");
    const ok = await applyPatch({ plan_status: "suspended" }, t("Account suspended"));
    if (ok) setStatus("suspended");
    setQuick(null);
  }

  async function handleReactivate() {
    setQuick("reactivate");
    const next: PlanStatus = plan === "trial" ? "trial" : "active";
    const ok = await applyPatch({ plan_status: next }, t("Account reactivated"));
    if (ok) setStatus(next);
    setQuick(null);
  }

  const isBlockedStatus =
    row.plan_status === "suspended" ||
    row.plan_status === "past_due" ||
    row.plan_status === "canceled";
  const busy = saving || quick !== null;

  return (
    <section className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <Link
            href="/platform"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            {t("All accounts")}
          </Link>
          <h1
            className="mt-1 truncate text-2xl font-bold tracking-tight text-foreground"
            data-no-translate
          >
            {row.name}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground" data-no-translate>
            {row.owner_name ? `${row.owner_name} · ` : ""}
            {row.owner_email ?? "—"} · {Number(row.members_count)}{" "}
            {Number(row.members_count) === 1 ? t("member") : t("members")} ·{" "}
            {Number(row.channels_count)}{" "}
            {Number(row.channels_count) === 1 ? t("channel") : t("channels")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground" data-no-translate>
            {t("Created")}{" "}
            {new Date(row.created_at).toLocaleDateString(language, {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })}{" "}
            · id {row.id}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <PlanStatusChip status={row.plan_status} blocked={!!resolveEntitlements(row).blocked} />
          {row.plan_status === "suspended" || isBlockedStatus ? (
            <Button
              variant="outline"
              onClick={handleReactivate}
              disabled={busy}
            >
              {quick === "reactivate" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <CheckCircle2 className="size-4" />
              )}
              {t("Reactivate")}
            </Button>
          ) : (
            <Button variant="destructive" onClick={handleSuspend} disabled={busy}>
              {quick === "suspend" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Ban className="size-4" />
              )}
              {t("Suspend")}
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <div className="space-y-5">
          {/* Plan / status / expiry */}
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">{t("Plan")}</CardTitle>
              <CardDescription className="text-muted-foreground">
                {t("The plan sets the default modules and limits; overrides below win over it.")}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-3">
              <div className="grid gap-2">
                <Label htmlFor="plan">{t("Plan")}</Label>
                <select
                  id="plan"
                  value={plan}
                  onChange={(e) => setPlan(e.target.value as Plan)}
                  className={selectClass}
                  disabled={busy}
                >
                  {PLANS.map((p) => (
                    <option key={p} value={p}>
                      {t(PLAN_LABELS[p])}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="plan_status">{t("Status")}</Label>
                <select
                  id="plan_status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as PlanStatus)}
                  className={selectClass}
                  disabled={busy}
                >
                  {PLAN_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {t(PLAN_STATUS_LABELS[s])}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="plan_expires_at">{t("Valid until")}</Label>
                <Input
                  id="plan_expires_at"
                  type="datetime-local"
                  value={expires}
                  onChange={(e) => setExpires(e.target.value)}
                  className="h-9"
                  disabled={busy}
                />
                <div className="flex flex-wrap gap-1">
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    onClick={() => setExpires(addDaysLocalInput(14))}
                    disabled={busy}
                  >
                    +14 {t("days")}
                  </button>
                  <span className="text-xs text-muted-foreground">·</span>
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    onClick={() => setExpires(addDaysLocalInput(30))}
                    disabled={busy}
                  >
                    +30 {t("days")}
                  </button>
                  <span className="text-xs text-muted-foreground">·</span>
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    onClick={() => setExpires("")}
                    disabled={busy}
                  >
                    {t("No expiry")}
                  </button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground sm:col-span-3">
                {t("Only a trial is blocked by the expiry date. Paid plans are blocked by status (past due, canceled, suspended).")}
              </p>
            </CardContent>
          </Card>

          {/* Module overrides */}
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">{t("Modules")}</CardTitle>
              <CardDescription className="text-muted-foreground">
                {t("Inbox and Contacts are always on. For the rest, \"Inherit\" follows the plan.")}
              </CardDescription>
            </CardHeader>
            <CardContent className="divide-y divide-border">
              {OPTIONAL_MODULES.map((m) => {
                const fromPlan = planDef.modules.includes(m);
                const effective = preview.entitlements.modules[m];
                const choice = modules[m];
                return (
                  <div
                    key={m}
                    className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground">
                        {t(MODULE_LABELS[m])}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t("Plan")}: {fromPlan ? t("On") : t("Off")}
                        {choice !== "inherit" ? (
                          <>
                            {" "}· {t("Override")}: {choice === "on" ? t("On") : t("Off")}
                          </>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider",
                          effective
                            ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
                            : "border-border bg-muted text-muted-foreground",
                        )}
                      >
                        {effective ? t("On") : t("Off")}
                      </span>
                      <select
                        aria-label={`${t(MODULE_LABELS[m])} — ${t("override")}`}
                        value={choice}
                        onChange={(e) =>
                          setModules((prev) => ({
                            ...prev,
                            [m]: e.target.value as ModuleChoice,
                          }))
                        }
                        className={cn(selectClass, "w-44")}
                        disabled={busy}
                      >
                        <option value="inherit">
                          {t("Inherit")} ({fromPlan ? t("On") : t("Off")})
                        </option>
                        <option value="on">{t("Force on")}</option>
                        <option value="off">{t("Force off")}</option>
                      </select>
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          {/* Limit overrides */}
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">{t("Limits")}</CardTitle>
              <CardDescription className="text-muted-foreground">
                {t("Seats count active members plus pending invites. Channels are connected WhatsApp numbers.")}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              {LIMIT_KEYS.map((k) => {
                const fromPlan = planDef.limits[k];
                const l = limits[k];
                const effective = preview.entitlements.limits[k];
                return (
                  <div key={k} className="grid gap-2">
                    <Label htmlFor={`limit-${k}`}>{t(LIMIT_LABELS[k])}</Label>
                    <div className="flex gap-2">
                      <select
                        id={`limit-${k}`}
                        value={l.choice}
                        onChange={(e) =>
                          setLimits((prev) => ({
                            ...prev,
                            [k]: { ...prev[k], choice: e.target.value as LimitChoice },
                          }))
                        }
                        className={selectClass}
                        disabled={busy}
                      >
                        <option value="inherit">
                          {t("Inherit")} ({fromPlan === null ? t("Unlimited") : fromPlan})
                        </option>
                        <option value="unlimited">{t("Unlimited")}</option>
                        <option value="custom">{t("Custom")}</option>
                      </select>
                      {l.choice === "custom" ? (
                        <Input
                          type="number"
                          min={0}
                          step={1}
                          value={l.custom}
                          onChange={(e) =>
                            setLimits((prev) => ({
                              ...prev,
                              [k]: { ...prev[k], custom: e.target.value },
                            }))
                          }
                          className="h-9 w-24"
                          aria-label={`${t(LIMIT_LABELS[k])} — ${t("custom value")}`}
                          disabled={busy}
                        />
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t("Effective")}:{" "}
                      <span className="font-medium text-foreground">
                        {effective === null ? t("Unlimited") : effective}
                      </span>
                    </p>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          {/* Notes */}
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">{t("Platform notes")}</CardTitle>
              <CardDescription className="text-muted-foreground">
                {t("Internal only — the customer never sees this.")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
                placeholder={t("Payment references, contact history, special deals…")}
                disabled={busy}
              />
            </CardContent>
          </Card>

          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link href="/platform" />}
            >
              {t("Cancel")}
            </Button>
            <Button onClick={handleSave} disabled={busy}>
              {saving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}
              {t("Save changes")}
            </Button>
          </div>
        </div>

        {/* Live preview */}
        <Card className="lg:sticky lg:top-6">
          <CardHeader>
            <CardTitle className="text-foreground">{t("Customer will see")}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t("Resolved from the form above, before saving.")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("Plan")}</span>
              <span className="font-medium text-foreground">
                {t(PLAN_LABELS[preview.entitlements.plan])}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("Access")}</span>
              {preview.entitlements.blocked ? (
                <span className="font-medium text-destructive">{t("Blocked")}</span>
              ) : (
                <span className="font-medium text-emerald-600 dark:text-emerald-300">
                  {t("Allowed")}
                </span>
              )}
            </div>
            <div>
              <div className="mb-1.5 text-muted-foreground">{t("Modules")}</div>
              <ul className="flex flex-wrap gap-1.5">
                {OPTIONAL_MODULES.map((m) => (
                  <li
                    key={m}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-xs",
                      preview.entitlements.modules[m]
                        ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
                        : "border-border bg-muted text-muted-foreground line-through",
                    )}
                  >
                    {t(MODULE_LABELS[m])}
                  </li>
                ))}
              </ul>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {LIMIT_KEYS.map((k) => (
                <div key={k}>
                  <div className="text-xs text-muted-foreground">{t(LIMIT_LABELS[k])}</div>
                  <div className="font-semibold text-foreground">
                    {preview.entitlements.limits[k] === null
                      ? t("Unlimited")
                      : preview.entitlements.limits[k]}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
