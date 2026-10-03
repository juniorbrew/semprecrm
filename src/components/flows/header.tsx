"use client";

/**
 * Editor header — flow name / description, status badge, dirty
 * indicator, and the action buttons (Save, Activate/Pause, Delete,
 * View runs, Back).
 *
 * Lifted out of flow-builder.tsx so the same header renders above
 * both views in FlowEditorShell. Without this, canvas users had no
 * way to save without toggling to list view.
 *
 * Reads everything from the editor context (`useFlowEditor`) so it
 * stays in sync with whichever view is mutating state, and routes
 * router navigation locally (back to /flows, View runs to
 * /flows/[id]/runs) — those don't belong in the hook.
 */

import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  History,
  Loader2,
  PauseCircle,
  PlayCircle,
  Save,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/hooks/use-language";
import {
  useFlowEditor,
  type BuilderState,
} from "./flow-editor-state";

export function EditorHeader() {
  const router = useRouter();
  const {
    flow,
    state,
    setState,
    dirty,
    saving,
    activating,
    canActivate,
    save,
    setStatus,
    deleteFlow,
  } = useFlowEditor();
  const { t } = useLanguage();

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <button
            type="button"
            onClick={() => router.push("/flows")}
            aria-label={t("Flows")}
            title={t("Flows")}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          >
            <ArrowLeft className="size-4" />
          </button>
          <Input
            value={state.name}
            onChange={(e) =>
              setState((s) => ({ ...s, name: e.target.value }))
            }
            placeholder={t("Flow name")}
            aria-label={t("Flow name")}
            className="h-8 min-w-0 max-w-md border-transparent bg-transparent px-1.5 text-base font-semibold shadow-none hover:border-border focus-visible:border-ring dark:bg-transparent md:text-base"
          />
          <StatusBadge status={state.status} />
          {dirty && (
            <span
              className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
              title={t("Unsaved changes — hit Save to persist")}
              aria-live="polite"
            >
              <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />
              {t("Edited")}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push(`/flows/${flow.id}/runs`)}
            className="text-muted-foreground hover:text-foreground"
          >
            <History className="size-3.5" />
            {t("Runs")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void deleteFlow()}
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
            {t("Delete")}
          </Button>
          {state.status === "active" ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void setStatus("draft")}
              disabled={activating}
            >
              {activating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <PauseCircle className="h-3.5 w-3.5" />
              )}
              {t("Pause")}
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void setStatus("active")}
              disabled={activating || !canActivate}
              title={
                !canActivate
                  ? t("Fix the issues below before activating")
                  : undefined
              }
            >
              {activating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <PlayCircle className="h-3.5 w-3.5" />
              )}
              {t("Activate")}
            </Button>
          )}
          <Button onClick={() => void save()} disabled={saving} size="sm">
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            {t("Save")}
          </Button>
        </div>
      </div>
      <Input
        value={state.description}
        onChange={(e) =>
          setState((s) => ({ ...s, description: e.target.value }))
        }
        placeholder={t("Optional description (internal — customers don't see this)")}
        aria-label={t("Description")}
        className="h-8 border-transparent bg-transparent px-1.5 text-sm text-muted-foreground shadow-none hover:border-border focus-visible:border-ring focus-visible:text-foreground dark:bg-transparent sm:ml-9 sm:max-w-2xl"
      />
    </div>
  );
}

const STATUS_LABEL: Record<BuilderState["status"], string> = {
  draft: "Draft",
  active: "Active",
  archived: "Archived",
};

function StatusBadge({ status }: { status: BuilderState["status"] }) {
  const { t } = useLanguage();
  const dot = {
    draft: "bg-muted-foreground/50",
    active: "bg-emerald-500",
    archived: "bg-muted-foreground/30",
  }[status];
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span className={cn("size-1.5 rounded-full", dot)} aria-hidden />
      {t(STATUS_LABEL[status])}
    </span>
  );
}
