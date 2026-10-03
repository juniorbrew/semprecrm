"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Pipeline, PipelineStage, Deal, DealStatus } from "@/types";
import { PipelineBoard } from "@/components/pipelines/pipeline-board";
import { PipelineSettings } from "@/components/pipelines/pipeline-settings";
import { DealForm } from "@/components/pipelines/deal-form";
import { DealDrawer } from "@/components/pipelines/deal-drawer";
import { PipelineAnalytics } from "@/components/pipelines/pipeline-analytics";
import {
  LostDealDialog,
  type LostDealInput,
} from "@/components/pipelines/lost-deal-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GitBranch, Plus, ChevronDown, Settings, Rows4 } from "lucide-react";
import { toast } from "sonner";
import { useCan } from "@/hooks/use-can";
import { useAuth } from "@/hooks/use-auth";
import { GatedButton } from "@/components/ui/gated-button";
import { useLanguage } from "@/hooks/use-language";
import { loadPipelineDeals } from "@/lib/pipelines/load-deals";
import { saveDealStatus } from "@/lib/pipelines/loss-reasons";
import {
  readBoardDensity,
  writeBoardDensity,
  type BoardDensity,
} from "@/lib/pipelines/board";
import type { Language } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const COPY: Record<
  Language,
  {
    newDeal: string;
    newPipeline: string;
    compact: string;
    selector: string;
    emptyTitle: string;
  }
> = {
  "pt-BR": {
    newDeal: "Novo negócio",
    newPipeline: "Novo funil",
    compact: "Cartões compactos",
    selector: "Trocar de funil",
    emptyTitle: "Crie um funil para acompanhar seus negócios.",
  },
  "en-US": {
    newDeal: "New deal",
    newPipeline: "New pipeline",
    compact: "Compact cards",
    selector: "Switch pipeline",
    emptyTitle: "Create a pipeline to track your deals.",
  },
};

// Pipeline creation is admin-class (settings-tier write under
// the new RLS); deal creation is operational and only requires
// agent+. The two CTAs gate on different `useCan` capabilities,
// not on different copy.

// Spec-defined seed — name and color per the product spec. Names are
// the English dictionary keys: stored as-is, the DOM translator renders
// them in pt-BR ("Novo lead" … "Ganho") wherever a stage name shows.
const SPEC_DEFAULT_STAGES = [
  { name: "New Lead", color: "#3b82f6", position: 0 }, // blue
  { name: "Qualified", color: "#eab308", position: 1 }, // yellow
  { name: "Proposal Sent", color: "#f97316", position: 2 }, // orange
  { name: "Negotiation", color: "#8b5cf6", position: 3 }, // purple
  { name: "Won", color: "#22c55e", position: 4 }, // green
];

export default function PipelinesPage() {
  const supabase = createClient();
  const { t, language } = useLanguage();
  const copy = COPY[language] ?? COPY["pt-BR"];
  const canEditSettings = useCan("edit-settings");
  const canCreateDeals = useCan("send-messages");
  const { accountId, user } = useAuth();
  const userId = user?.id ?? null;

  // Card density, per user on this device. Read after mount (localStorage
  // in the initializer would be a hydration mismatch).
  const [density, setDensity] = useState<BoardDensity>("comfortable");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (userId) setDensity(readBoardDensity(userId));
  }, [userId]);
  const toggleDensity = useCallback(() => {
    setDensity((d) => {
      const next: BoardDensity = d === "compact" ? "comfortable" : "compact";
      if (userId) writeBoardDensity(userId, next);
      return next;
    });
  }, [userId]);

  // Quick "lost" from a card asks for the reason first (same dialog as
  // the drawer); "won" saves right away.
  const [lostDeal, setLostDeal] = useState<Deal | null>(null);

  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [selectedPipelineId, setSelectedPipelineId] = useState<string>("");
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);

  // Dialog / sheet state
  const [newPipelineOpen, setNewPipelineOpen] = useState(false);
  const [newPipelineName, setNewPipelineName] = useState("");
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Deal form state is lifted here so both the top-bar "Adicionar negócio" and
  // the per-column "+" trigger the same Sheet.
  const [dealFormOpen, setDealFormOpen] = useState(false);
  const [defaultStageId, setDefaultStageId] = useState<string>("");

  // Clicking a card opens the deal drawer (read view first). Only the
  // id is stored so the drawer always renders the live row from
  // `deals` and reflects status / stage changes after a refetch.
  const [drawerDealId, setDrawerDealId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // `?deal=<id>` (calendar / task links): switch to the deal's pipeline
  // and open its drawer once the board has that row. Applied once.
  const searchParams = useSearchParams();
  const deepLinkDealId = searchParams.get("deal");
  const deepLinkApplied = useRef<string | null>(null);

  // Guard against double-seeding (React StrictMode double-effect in dev).
  const seedAttempted = useRef(false);

  const loadPipelines = useCallback(async () => {
    const { data, error } = await supabase
      .from("pipelines")
      .select("*")
      .order("created_at");
    if (error) {
      console.error("Falha ao carregar funis:", error.message);
      return [];
    }
    return data ?? [];
  }, [supabase]);

  const loadStages = useCallback(
    async (pipelineId: string) => {
      const { data } = await supabase
        .from("pipeline_stages")
        .select("*")
        .eq("pipeline_id", pipelineId)
        .order("position");
      return data ?? [];
    },
    [supabase],
  );

  const loadDeals = useCallback(
    async (pipelineId: string) => {
      const { deals, problem } = await loadPipelineDeals(supabase, pipelineId);
      if (problem === "failed") toast.error(t("Failed to load deals"));
      else if (problem === "degraded")
        toast.warning(t("Deals loaded without their companies — reload the page to try again"));
      return deals;
    },
    [supabase, t],
  );

  const seedDefaultPipeline = useCallback(async (): Promise<Pipeline | null> => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) return null;
    // pipelines.account_id is NOT NULL post-017 with no DB default.
    if (!accountId) return null;

    const { data: pipeline, error } = await supabase
      .from("pipelines")
      .insert({ user_id: user.id, account_id: accountId, name: "Sales Pipeline" })
      .select()
      .single();

    if (error || !pipeline) {
      console.error("Failed to seed pipeline:", error?.message);
      return null;
    }

    const stagesPayload = SPEC_DEFAULT_STAGES.map((s) => ({
      pipeline_id: pipeline.id,
      name: s.name,
      color: s.color,
      position: s.position,
    }));
    await supabase.from("pipeline_stages").insert(stagesPayload);

    return pipeline as Pipeline;
  }, [supabase, accountId]);

  // Initial load + seed-if-empty
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      let list = await loadPipelines();

      if (list.length === 0 && !seedAttempted.current) {
        seedAttempted.current = true;
        const seeded = await seedDefaultPipeline();
        if (seeded) list = await loadPipelines();
      }

      if (cancelled) return;
      setPipelines(list);
      if (list.length > 0) {
        setSelectedPipelineId((prev) =>
          prev && list.some((p) => p.id === prev) ? prev : list[0].id,
        );
      } else {
        setSelectedPipelineId("");
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadPipelines, seedDefaultPipeline]);

  // Load stages + deals whenever selected pipeline changes.
  // Clearing on no-selection is a legitimate sync with URL/prop
  // state; the load completion uses async setters inside promise
  // callbacks (not synchronous in the effect body).
  useEffect(() => {
    if (!selectedPipelineId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStages([]);
      setDeals([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const [s, d] = await Promise.all([
        loadStages(selectedPipelineId),
        loadDeals(selectedPipelineId),
      ]);
      if (cancelled) return;
      setStages(s);
      setDeals(d);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPipelineId, loadStages, loadDeals]);

  const refreshPipelines = useCallback(async () => {
    const list = await loadPipelines();
    setPipelines(list);
    if (list.length === 0) setSelectedPipelineId("");
    else if (!list.some((p) => p.id === selectedPipelineId))
      setSelectedPipelineId(list[0].id);
  }, [loadPipelines, selectedPipelineId]);

  const refreshStages = useCallback(async () => {
    if (!selectedPipelineId) return;
    setStages(await loadStages(selectedPipelineId));
  }, [loadStages, selectedPipelineId]);

  const refreshDeals = useCallback(async () => {
    if (!selectedPipelineId) return;
    setDeals(await loadDeals(selectedPipelineId));
  }, [loadDeals, selectedPipelineId]);

  const handleDealMoved = useCallback(
    async (dealId: string, newStageId: string) => {
      // Optimistic update — board already animated; just persist.
      setDeals((prev) =>
        prev.map((d) => (d.id === dealId ? { ...d, stage_id: newStageId } : d)),
      );
      const { error } = await supabase
        .from("deals")
        .update({ stage_id: newStageId, updated_at: new Date().toISOString() })
        .eq("id", dealId);
      if (error) {
        toast.error("Failed to move deal");
      }
      // Refetch either way so `updated_at` (shown in the drawer
      // timeline) and any server-side changes come back.
      await refreshDeals();
    },
    [supabase, refreshDeals],
  );

  const handleAddDeal = useCallback(
    (stageId?: string) => {
      setDefaultStageId(stageId ?? stages[0]?.id ?? "");
      setDealFormOpen(true);
    },
    [stages],
  );

  const handleQuickStatus = useCallback(
    async (deal: Deal, status: DealStatus) => {
      if (status === "lost") {
        setLostDeal(deal);
        return;
      }
      if (!(await saveDealStatus(supabase, deal.id, status))) {
        toast.error(t("Failed to update deal status"));
        return;
      }
      toast.success(status === "won" ? t("Marked as won") : t("Deal reopened"));
      await refreshDeals();
    },
    [supabase, t, refreshDeals],
  );

  const handleQuickLost = useCallback(
    async (input: LostDealInput) => {
      if (!lostDeal) return;
      const ok = await saveDealStatus(supabase, lostDeal.id, "lost", {
        reasonId: input.reasonId,
        note: input.note,
      });
      if (!ok) {
        toast.error(t("Failed to update deal status"));
        return;
      }
      setLostDeal(null);
      toast.success(t("Marked as lost"));
      await refreshDeals();
    },
    [lostDeal, supabase, t, refreshDeals],
  );

  const handleOpenDeal = useCallback((deal: Deal) => {
    setDrawerDealId(deal.id);
    setDrawerOpen(true);
  }, []);

  const drawerDeal = drawerDealId
    ? deals.find((d) => d.id === drawerDealId) ?? null
    : null;

  useEffect(() => {
    if (!deepLinkDealId || loading || deepLinkApplied.current === deepLinkDealId) return;
    if (deals.some((d) => d.id === deepLinkDealId)) {
      deepLinkApplied.current = deepLinkDealId;
      // Syncing URL state into the drawer once the board has the row.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDrawerDealId(deepLinkDealId);
      setDrawerOpen(true);
      return;
    }
    // Not on this board — look the deal up and jump to its pipeline.
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("deals")
        .select("id, pipeline_id")
        .eq("id", deepLinkDealId)
        .maybeSingle();
      if (cancelled || !data) return;
      const row = data as { id: string; pipeline_id: string };
      if (row.pipeline_id === selectedPipelineId) {
        // Same pipeline but the list has not caught up yet — wait for it.
        return;
      }
      if (pipelines.some((p) => p.id === row.pipeline_id)) {
        setSelectedPipelineId(row.pipeline_id);
      } else {
        deepLinkApplied.current = deepLinkDealId;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deepLinkDealId, loading, deals, pipelines, selectedPipelineId, supabase]);

  async function handleCreatePipeline() {
    const name = newPipelineName.trim();
    if (!name) return;
    setCreating(true);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      setCreating(false);
      return;
    }
    // pipelines.account_id is NOT NULL post-017 with no DB default.
    if (!accountId) {
      toast.error("Your profile is not linked to an account.");
      setCreating(false);
      return;
    }

    const { data: pipeline, error } = await supabase
      .from("pipelines")
      .insert({ user_id: user.id, account_id: accountId, name })
      .select()
      .single();

    if (error || !pipeline) {
      toast.error("Failed to create pipeline");
      setCreating(false);
      return;
    }

    const stagesPayload = SPEC_DEFAULT_STAGES.map((s) => ({
      pipeline_id: pipeline.id,
      name: s.name,
      color: s.color,
      position: s.position,
    }));
    await supabase.from("pipeline_stages").insert(stagesPayload);

    setNewPipelineName("");
    setNewPipelineOpen(false);
    setSelectedPipelineId(pipeline.id);
    await refreshPipelines();
    setCreating(false);
    toast.success("Pipeline created");
  }

  const selectedPipeline = pipelines.find((p) => p.id === selectedPipelineId);

  if (loading) {
    return (
      <div className="space-y-5" aria-busy="true">
        <div className="flex items-center justify-between">
          <div className="h-8 w-48 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
          <div className="h-8 w-32 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        </div>
        <div className="flex gap-2.5 overflow-hidden">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="h-96 w-72 shrink-0 animate-pulse rounded-[var(--radius)] bg-muted/45 motion-reduce:animate-none"
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    // `board-fit` (globals.css: ≥80rem wide and ≥760px tall): fill
    // <main> so the board takes the leftover height and scrolls per
    // column while header + KPIs stay visible. Otherwise the page keeps
    // its natural height and <main> scrolls as before.
    <div className="space-y-5 board-fit:flex board-fit:h-full board-fit:flex-col">
      {/* Header: pipeline selector, quiet utilities, one filled action. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={copy.selector}
            className="-ml-2 inline-flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-muted"
          >
            <GitBranch className="size-4 shrink-0 text-primary" aria-hidden />
            <span className="truncate text-base font-semibold">
              {selectedPipeline?.name ?? "Select Pipeline"}
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-64 border-border bg-popover text-popover-foreground"
          >
            {pipelines.length === 0 && (
              <DropdownMenuItem disabled className="text-muted-foreground">
                No pipelines yet
              </DropdownMenuItem>
            )}
            {pipelines.map((p) => (
              <DropdownMenuItem
                key={p.id}
                onClick={() => setSelectedPipelineId(p.id)}
                aria-current={p.id === selectedPipelineId ? "true" : undefined}
                className={cn(
                  p.id === selectedPipelineId
                    ? "bg-primary/10 font-semibold text-foreground"
                    : "text-popover-foreground",
                )}
              >
                <GitBranch
                  className={cn(
                    "mr-2 size-3.5",
                    p.id === selectedPipelineId ? "text-primary" : "opacity-70",
                  )}
                />
                {p.name}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator className="bg-border" />
            {selectedPipeline && (
              <DropdownMenuItem
                onClick={() => setSettingsOpen(true)}
                className="text-popover-foreground"
              >
                <Settings className="mr-2 size-3.5" />
                Manage Pipelines
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex items-center gap-1.5">
          {pipelines.length > 0 && (
            <button
              type="button"
              onClick={toggleDensity}
              aria-pressed={density === "compact"}
              aria-label={copy.compact}
              title={copy.compact}
              data-testid="density-toggle"
              className={cn(
                "inline-flex size-8 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                density === "compact"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Rows4 className="size-4" aria-hidden />
            </button>
          )}
          <GatedButton
            variant="ghost"
            canAct={canEditSettings}
            gateReason="create pipelines"
            onClick={() => setNewPipelineOpen(true)}
            className="text-muted-foreground hover:text-foreground"
          >
            <Plus className="mr-1 size-4" />
            {copy.newPipeline}
          </GatedButton>
          <GatedButton
            canAct={canCreateDeals}
            gateReason="create deals"
            disabled={!selectedPipelineId || stages.length === 0}
            onClick={() => handleAddDeal()}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="mr-1 size-4" />
            {copy.newDeal}
          </GatedButton>
        </div>
      </div>

      {/* Board */}
      {pipelines.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
          <p className="text-sm text-muted-foreground">{copy.emptyTitle}</p>
          <GatedButton
            variant="outline"
            canAct={canEditSettings}
            gateReason="create pipelines"
            onClick={() => setNewPipelineOpen(true)}
          >
            <Plus className="mr-1 size-4" />
            {copy.newPipeline}
          </GatedButton>
        </div>
      ) : (
        <>
          <PipelineAnalytics stages={stages} deals={deals} />
          <PipelineBoard
            stages={stages}
            deals={deals}
            compact={density === "compact"}
            onDealMoved={handleDealMoved}
            onAddDeal={canCreateDeals ? handleAddDeal : undefined}
            onEditDeal={handleOpenDeal}
            onStatus={canCreateDeals ? handleQuickStatus : undefined}
          />
        </>
      )}

      {/* New Pipeline Dialog */}
      <Dialog open={newPipelineOpen} onOpenChange={setNewPipelineOpen}>
        <DialogContent className="sm:max-w-sm bg-popover border-border">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">Novo funil</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Label className="text-muted-foreground">Pipeline Name</Label>
            <Input
              value={newPipelineName}
              onChange={(e) => setNewPipelineName(e.target.value)}
              placeholder="e.g. Enterprise sales"
              className="mt-2 bg-muted border-border text-foreground"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreatePipeline();
              }}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              Default stages (New Lead → Won) will be created automatically.
            </p>
          </div>
          <DialogFooter className="bg-popover/50 border-border">
            <Button
              variant="outline"
              onClick={() => setNewPipelineOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Cancelar
            </Button>
            <Button
              onClick={handleCreatePipeline}
              disabled={creating || !newPipelineName.trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {creating ? "Criando..." : "Criar funil"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pipeline Settings */}
      {selectedPipeline && (
        <PipelineSettings
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          pipeline={selectedPipeline}
          stages={stages}
          onPipelinesChanged={refreshPipelines}
          onStagesChanged={refreshStages}
          onCreateNewPipeline={() => {
            setSettingsOpen(false);
            setNewPipelineOpen(true);
          }}
        />
      )}

      {/* New deal (Sheet) */}
      <DealForm
        open={dealFormOpen}
        onOpenChange={setDealFormOpen}
        deal={null}
        pipelineId={selectedPipelineId}
        stages={stages}
        defaultStageId={defaultStageId}
        onSaved={refreshDeals}
      />

      {/* Quick "lost" from a card */}
      <LostDealDialog
        open={!!lostDeal}
        onOpenChange={(next) => {
          if (!next) setLostDeal(null);
        }}
        deal={lostDeal}
        onConfirm={handleQuickLost}
      />

      {/* Existing deal: read view first, edit second */}
      <DealDrawer
        open={drawerOpen && !!drawerDeal}
        onOpenChange={(next) => {
          setDrawerOpen(next);
          if (!next) setDrawerDealId(null);
        }}
        deal={drawerDeal}
        pipelineId={selectedPipelineId}
        stages={stages}
        onChanged={refreshDeals}
        onDealMoved={handleDealMoved}
      />
    </div>
  );
}
