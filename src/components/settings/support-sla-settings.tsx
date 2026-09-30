"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import { notifySlaPoliciesChanged } from "@/hooks/use-sla-policies";
import { createClient } from "@/lib/supabase/client";
import { PRIORITIES, PRIORITY_DOT, supportCopy } from "@/lib/support/model";
import { joinMinutes, slaCopy, splitMinutes, type SlaPolicy } from "@/lib/support/sla";
import { invalidPolicy, listSlaPolicies, saveSlaPolicies } from "@/lib/support/sla-policies";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { SettingsGroup } from "./settings-group";

type Unit = "min" | "h";
interface Cell {
  value: string;
  unit: Unit;
}
type Draft = Record<SlaPolicy["priority"], { first: Cell; resolution: Cell }>;

function toDraft(policies: readonly SlaPolicy[]): Draft {
  const draft = {} as Draft;
  for (const priority of PRIORITIES) {
    const row = policies.find((p) => p.priority === priority);
    draft[priority] = {
      first: splitMinutes(row?.first_response_minutes ?? null),
      resolution: splitMinutes(row?.resolution_minutes ?? null),
    };
  }
  return draft;
}

function toPolicies(draft: Draft): SlaPolicy[] {
  return PRIORITIES.map((priority) => ({
    priority,
    first_response_minutes: joinMinutes(draft[priority].first.value, draft[priority].first.unit),
    resolution_minutes: joinMinutes(draft[priority].resolution.value, draft[priority].resolution.unit),
  }));
}

/**
 * Settings → Suporte → Prazos: a four-row table (priority x first response /
 * resolution) and the business-hours switch. Edits save when a field loses
 * focus, like the rest of the page; an empty field means no deadline.
 */
export function SlaSettings({ readOnly }: { readOnly: boolean }) {
  const { language } = useLanguage();
  const copy = slaCopy(language);
  const shared = supportCopy(language);
  const { accountId, preferences, refreshAccount } = useAuth();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [savingSwitch, setSavingSwitch] = useState(false);
  // What the database holds, so a blur without a change writes nothing.
  const savedRef = useRef("");

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    listSlaPolicies(createClient(), accountId)
      .then((rows) => {
        if (cancelled) return;
        const loaded = toDraft(rows);
        savedRef.current = JSON.stringify(toPolicies(loaded));
        setDraft(loaded);
      })
      .catch((err) => {
        console.error(err);
        if (!cancelled) setDraft(toDraft([]));
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  async function commit(next: Draft) {
    if (!accountId) return;
    const policies = toPolicies(next);
    // A typed but unusable value (0, text, too large) is refused, not silently dropped.
    const typedBad = PRIORITIES.some(
      (p) =>
        (next[p].first.value.trim() !== "" && joinMinutes(next[p].first.value, next[p].first.unit) === null) ||
        (next[p].resolution.value.trim() !== "" && joinMinutes(next[p].resolution.value, next[p].resolution.unit) === null) ||
        policies.some((row) => invalidPolicy(row)),
    );
    setInvalid(typedBad);
    if (typedBad) {
      toast.error(copy.invalid);
      return;
    }
    if (JSON.stringify(policies) === savedRef.current) return;
    try {
      await saveSlaPolicies(createClient(), accountId, policies);
      savedRef.current = JSON.stringify(policies);
      notifySlaPoliciesChanged();
    } catch (err) {
      console.error(err);
      toast.error(shared.saveFailed);
    }
  }

  function edit(priority: SlaPolicy["priority"], field: "first" | "resolution", change: Partial<Cell>, save: boolean) {
    if (!draft) return;
    const next = { ...draft, [priority]: { ...draft[priority], [field]: { ...draft[priority][field], ...change } } };
    setDraft(next);
    if (save) void commit(next);
  }

  async function toggleBusinessOnly(next: boolean) {
    setSavingSwitch(true);
    try {
      const res = await fetch("/api/account/preferences", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sla_count_only_business_hours: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refreshAccount();
    } catch (err) {
      console.error(err);
      toast.error(shared.saveFailed);
    } finally {
      setSavingSwitch(false);
    }
  }

  const unitLabel = (u: Unit) => (u === "h" ? copy.hours : copy.minutes);

  return (
    <SettingsGroup title={copy.title} description={copy.intro}>
      <div role="table" aria-label={copy.title} className="max-w-2xl">
        <div role="row" className="grid grid-cols-[minmax(6rem,1fr)_minmax(0,1.4fr)_minmax(0,1.4fr)] gap-3 pb-2 text-xs text-muted-foreground">
          <span role="columnheader">{copy.priority}</span>
          <span role="columnheader">{copy.firstResponse}</span>
          <span role="columnheader">{copy.resolution}</span>
        </div>
        <div className="divide-y divide-border border-t border-border">
          {PRIORITIES.map((priority) => (
            <div
              key={priority}
              role="row"
              data-testid={`sla-row-${priority}`}
              className="grid grid-cols-[minmax(6rem,1fr)_minmax(0,1.4fr)_minmax(0,1.4fr)] items-center gap-3 py-2"
            >
              <span role="cell" className="flex items-center gap-2 text-sm text-foreground">
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", PRIORITY_DOT[priority])} aria-hidden />
                {shared.priorities[priority]}
              </span>
              {(["first", "resolution"] as const).map((field) => {
                const cell = draft?.[priority][field] ?? { value: "", unit: "h" as Unit };
                const label = `${field === "first" ? copy.firstResponse : copy.resolution}: ${shared.priorities[priority]}`;
                return (
                  <span key={field} role="cell" className="flex items-center gap-1.5">
                    <Input
                      inputMode="decimal"
                      value={cell.value}
                      disabled={readOnly || !draft}
                      aria-label={label}
                      aria-invalid={invalid && cell.value.trim() !== "" && joinMinutes(cell.value, cell.unit) === null}
                      placeholder="—"
                      onChange={(e) => edit(priority, field, { value: e.target.value }, false)}
                      onBlur={() => void commit(draft!)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      }}
                      className="h-8 w-16 px-2 text-sm tabular-nums"
                    />
                    <select
                      value={cell.unit}
                      disabled={readOnly || !draft}
                      aria-label={`${label} (${copy.minutes}/${copy.hours})`}
                      onChange={(e) => edit(priority, field, { unit: e.target.value as Unit }, true)}
                      className="h-8 rounded-md border border-border bg-transparent px-1.5 text-xs text-foreground disabled:opacity-60"
                    >
                      {(["h", "min"] as const).map((u) => (
                        <option key={u} value={u}>
                          {unitLabel(u)}
                        </option>
                      ))}
                    </select>
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="flex max-w-2xl items-start justify-between gap-4 border-t border-border pt-4">
        <div className="min-w-0">
          <p id="sla-business-only" className="text-sm font-medium text-foreground">
            {copy.businessOnly}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{copy.businessOnlyBody}</p>
        </div>
        <Switch
          checked={preferences.sla_count_only_business_hours}
          disabled={readOnly || savingSwitch}
          onCheckedChange={(v) => void toggleBusinessOnly(Boolean(v))}
          aria-labelledby="sla-business-only"
        />
      </div>
      {readOnly && <p className="text-xs text-muted-foreground">{copy.readOnly}</p>}
    </SettingsGroup>
  );
}
