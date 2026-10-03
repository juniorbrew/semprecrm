"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Plus,
  Loader2,
  MessageSquare,
  HelpCircle,
  UserPlus,
  FileText,
  Rows4,
} from "lucide-react";

import { useCan } from "@/hooks/use-can";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/ui/gated-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/hooks/use-language";
import { translateLiteral } from "@/lib/i18n";
import { getFlowTemplate, localizeFlowTemplate } from "@/lib/flows/templates";
import {
  FLOWS_COPY,
  FlowListRow,
  readFlowsDensity,
  writeFlowsDensity,
  type FlowRow,
  type FlowsDensity,
} from "@/components/flows/flow-list-row";

/**
 * Flows list page.
 *
 * Open to every authenticated user. Flows is in soft-GA — the "Beta"
 * chip in the sidebar is the only remaining signal that the surface
 * is new. The previous per-account beta gate was removed in PR #134.
 */

interface TemplateSummary {
  slug: string;
  name: string;
  description: string;
  icon: "MessageSquare" | "HelpCircle" | "UserPlus";
  trigger_type: string;
  node_count: number;
}

const TEMPLATE_ICONS = {
  MessageSquare,
  HelpCircle,
  UserPlus,
} as const;

export default function FlowsPage() {
  const router = useRouter();
  const { t, language } = useLanguage();
  const copy = FLOWS_COPY[language] ?? FLOWS_COPY["pt-BR"];
  const userId = useAuth().user?.id;
  const canCreate = useCan("send-messages");
  const [flows, setFlows] = useState<FlowRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);

  // Row density, per user on this device (read after mount: no hydration mismatch).
  const [density, setDensity] = useState<FlowsDensity>("comfortable");
  useEffect(() => {
    if (userId) setDensity(readFlowsDensity(userId));
  }, [userId]);
  const toggleDensity = useCallback(() => {
    setDensity((d) => {
      const next: FlowsDensity = d === "compact" ? "comfortable" : "compact";
      if (userId) writeFlowsDensity(userId, next);
      return next;
    });
  }, [userId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [flowsRes, tmplRes] = await Promise.all([
          fetch("/api/flows"),
          fetch("/api/flows/templates"),
        ]);
        if (!flowsRes.ok) {
          throw new Error(`Failed to load flows: ${flowsRes.status}`);
        }
        const flowsJson = (await flowsRes.json()) as { flows: FlowRow[] };
        if (!cancelled) setFlows(flowsJson.flows ?? []);
        // Templates endpoint is forward-looking — if it 404s on an
        // older deployment, gracefully fall through.
        if (tmplRes.ok) {
          const tmplJson = (await tmplRes.json()) as {
            templates: TemplateSummary[];
          };
          if (!cancelled) setTemplates(tmplJson.templates ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          console.error(err);
          // Literal on purpose: `t` would become an effect dependency;
          // the DOM translator localises the toast anyway.
          toast.error("Couldn't load flows.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          trigger_type: "keyword",
          trigger_config: { keywords: [] },
        }),
      });
      if (!res.ok) throw new Error(`Create failed: ${res.status}`);
      const json = (await res.json()) as { flow: FlowRow };
      setCreateOpen(false);
      setNewName("");
      router.push(`/flows/${json.flow.id}`);
    } catch (err) {
      console.error(err);
      toast.error(t("Couldn't create flow."));
    } finally {
      setCreating(false);
    }
  }

  async function handleUseTemplate(slug: string) {
    setCreating(true);
    try {
      const res = await fetch("/api/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template_slug: slug }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(typeof json.error === "string" ? json.error : "");
      }
      const json = (await res.json()) as { flow: FlowRow };
      // The clone endpoint copies the English source template. For a
      // pt-BR user, rewrite the copy (name, keywords, message bodies,
      // button titles, notes) through the same PUT the editor's Save
      // uses. Structure is identical, so a failure here only leaves
      // the English copy in place — the flow itself is already created.
      const template = getFlowTemplate(slug);
      if (language === "pt-BR" && template) {
        const localized = localizeFlowTemplate(template, language);
        await fetch(`/api/flows/${json.flow.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: localized.name,
            description: localized.description,
            trigger_type: localized.trigger_type,
            trigger_config: localized.trigger_config,
            entry_node_id: localized.entry_node_id,
            nodes: localized.nodes,
          }),
        }).catch(() => null);
      }
      setCreateOpen(false);
      router.push(`/flows/${json.flow.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      toast.error(msg || t("Couldn't create flow."));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(flow: FlowRow) {
    // window.confirm is native UI, so the DOM translator never sees it —
    // translate the literal by hand.
    const yes = window.confirm(
      translateLiteral(
        `Delete "${flow.name}"? Any active runs will end immediately.`,
        language,
      ),
    );
    if (!yes) return;
    try {
      const res = await fetch(`/api/flows/${flow.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
      setFlows((prev) => prev.filter((f) => f.id !== flow.id));
      toast.success(t("Flow deleted."));
    } catch (err) {
      console.error(err);
      toast.error(t("Couldn't delete flow."));
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header: title + count, one filled action */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{copy.title}</h1>
        {flows.length > 0 && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-bold tabular-nums text-muted-foreground">
            {flows.length}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {flows.length > 0 && (
            <button
              type="button"
              onClick={toggleDensity}
              aria-pressed={density === "compact"}
              aria-label={copy.compact}
              title={copy.compact}
              data-testid="flows-density-toggle"
              className={cn(
                "inline-flex size-7 items-center justify-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                density === "compact"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Rows4 className="size-3.5" />
            </button>
          )}
          <GatedButton
            size="sm"
            canAct={canCreate}
            gateReason={t("create flows")}
            onClick={() => setCreateOpen(true)}
          >
            <Plus />
            {copy.newFlow}
          </GatedButton>
        </div>
      </div>

      {flows.length === 0 ? (
        <div className="max-w-md py-10">
          <p className="text-sm text-foreground">{copy.empty}</p>
          <p className="mt-1 text-sm text-muted-foreground">{copy.emptyHint}</p>
          {canCreate && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCreateOpen(true)}
              className="-ml-2.5 mt-3 text-primary hover:text-primary"
            >
              <Plus />
              {copy.firstFlow}
            </Button>
          )}
        </div>
      ) : (
        <ul className="divide-y divide-border border-y border-border">
          {flows.map((flow) => (
            <FlowListRow
              key={flow.id}
              flow={flow}
              language={language}
              copy={copy}
              compact={density === "compact"}
              onDelete={() => handleDelete(flow)}
            />
          ))}
        </ul>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        {/* `sm:max-w-4xl` not `max-w-4xl` — shadcn's DialogContent has
            `sm:max-w-sm` baked into its default classes. Without the
            sm: prefix our override applies at base only and the
            sm-scoped 384px wins at every real desktop breakpoint. */}
        <DialogContent className="sm:max-w-4xl bg-popover text-popover-foreground">
          <DialogHeader>
            <DialogTitle>{t("Create a new flow")}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t("Start from a template or build from scratch.")}
            </DialogDescription>
          </DialogHeader>

          {templates.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                {t("Start with a template")}
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {templates.map((tmpl) => {
                  const Icon = TEMPLATE_ICONS[tmpl.icon] ?? FileText;
                  return (
                    <button
                      key={tmpl.slug}
                      type="button"
                      onClick={() => handleUseTemplate(tmpl.slug)}
                      disabled={creating}
                      className="flex items-start gap-3 rounded-lg border border-border p-3 text-left transition-colors duration-150 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 motion-reduce:transition-none"
                    >
                      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-popover-foreground">
                          {t(tmpl.name)}
                        </span>
                        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                          {t(tmpl.description)}
                        </span>
                        <span className="mt-1 block text-[11px] tabular-nums text-muted-foreground">
                          {tmpl.node_count} {t(tmpl.node_count === 1 ? "node" : "nodes")}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="space-y-2 border-t border-border pt-4">
            <label
              htmlFor="new-flow-name"
              className="block text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground"
            >
              {t("Or start blank")}
            </label>
            <Input
              id="new-flow-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t("e.g. Welcome menu")}
              className="h-8"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
              }}
            />
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
            >
              {t("Cancel")}
            </Button>
            <Button onClick={handleCreate} disabled={!newName.trim() || creating}>
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("Create blank flow")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
