"use client";

import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  closestCorners,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { Deal, DealStatus, PipelineStage } from "@/types";
import { DealCard } from "./deal-card";
import { Plus } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import type { Language } from "@/lib/i18n";
import { dndAccessibility } from "@/lib/dnd-accessibility";
import { formatCurrency } from "@/lib/currency";
import { cn } from "@/lib/utils";

const COPY: Record<
  Language,
  {
    add: string;
    addTo: (stage: string) => string;
    empty: string;
    dropHere: string;
    column: (stage: string, n: number) => string;
  }
> = {
  "pt-BR": {
    add: "Novo negócio",
    addTo: (s) => `Novo negócio em ${s}`,
    empty: "Nenhum negócio nesta etapa.",
    dropHere: "Solte o negócio aqui.",
    column: (s, n) => `${s}, ${n} ${n === 1 ? "negócio" : "negócios"}`,
  },
  "en-US": {
    add: "New deal",
    addTo: (s) => `New deal in ${s}`,
    empty: "No deals in this stage.",
    dropHere: "Drop the deal here.",
    column: (s, n) => `${s}, ${n} ${n === 1 ? "deal" : "deals"}`,
  },
};

interface PipelineBoardProps {
  stages: PipelineStage[];
  deals: Deal[];
  onDealMoved: (dealId: string, newStageId: string) => void;
  /** Omitted for viewers (no deal writes). */
  onAddDeal?: (stageId: string) => void;
  onEditDeal: (deal: Deal) => void;
  /** Quick won / lost from a card; omitted for viewers. */
  onStatus?: (deal: Deal, status: DealStatus) => void;
  compact?: boolean;
}

export function PipelineBoard({
  stages,
  deals,
  onDealMoved,
  onAddDeal,
  onEditDeal,
  onStatus,
  compact = false,
}: PipelineBoardProps) {
  const { defaultCurrency } = useAuth();
  const { language } = useLanguage();
  const [activeDealId, setActiveDealId] = useState<string | null>(null);

  const sortedStages = useMemo(
    () => [...stages].sort((a, b) => a.position - b.position),
    [stages],
  );

  const dealsByStage = useMemo(() => {
    const map = new Map<string, Deal[]>();
    for (const stage of sortedStages) map.set(stage.id, []);
    for (const deal of deals) {
      const bucket = map.get(deal.stage_id);
      if (bucket) bucket.push(deal);
    }
    return map;
  }, [sortedStages, deals]);

  const sensors = useSensors(
    // 5px activation distance avoids clicks being interpreted as drags.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    // Keyboard drag support: focus a card, Space to pick up, arrows to move,
    // Space (or Enter) to drop, Escape to cancel. Enter is not a start key
    // so it keeps opening the focused card.
    useSensor(KeyboardSensor, {
      keyboardCodes: {
        start: ["Space"],
        cancel: ["Escape"],
        end: ["Space", "Enter"],
      },
    }),
  );

  const activeDeal = activeDealId
    ? deals.find((d) => d.id === activeDealId) ?? null
    : null;

  function handleDragStart(event: DragStartEvent) {
    setActiveDealId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDealId(null);
    const { active, over } = event;
    if (!over) return;
    const dealId = String(active.id);
    const targetStageId = String(over.id);

    const deal = deals.find((d) => d.id === dealId);
    if (!deal || deal.stage_id === targetStageId) return;
    if (!sortedStages.some((s) => s.id === targetStageId)) return;

    onDealMoved(dealId, targetStageId);
  }

  function handleDragCancel() {
    setActiveDealId(null);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      accessibility={dndAccessibility(language)}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {/* snap-x + snap-mandatory on mobile so swipes land the next
          stage cleanly at the viewport edge instead of mid-column.
          Disabled on lg+ where snapping would interfere with the
          natural layout. The board can still overflow horizontally on
          lg+ once a pipeline has many stages (columns keep a 260px
          min-width), so a thin scrollbar stays visible on desktop. */}
      {/* Under the `board-fit` variant (globals.css) the page is a
          full-height flex column, so the board takes the remaining
          height and each column scrolls its own card list; header, KPI
          strip and stage headers stay put while a long column is read. */}
      <div className="pipeline-scroll flex snap-x snap-mandatory scroll-px-4 gap-2.5 overflow-x-auto pb-3 lg:snap-none board-fit:min-h-0 board-fit:flex-1">
        {sortedStages.map((stage) => {
          const stageDeals = dealsByStage.get(stage.id) ?? [];
          const totalValue = stageDeals.reduce(
            (s, d) => s + Number(d.value || 0),
            0,
          );
          return (
            <StageColumn
              key={stage.id}
              stage={stage}
              deals={stageDeals}
              totalValue={totalValue}
              currency={defaultCurrency}
              compact={compact}
              onAddDeal={onAddDeal}
              onEditDeal={onEditDeal}
              onStatus={onStatus}
            />
          );
        })}
      </div>

      <DragOverlay
        dropAnimation={{
          duration: 200,
          easing: "cubic-bezier(0.2, 0, 0, 1)",
        }}
      >
        {activeDeal ? (
          <DealCard
            deal={activeDeal}
            stage={
              sortedStages.find((s) => s.id === activeDeal.stage_id) ?? null
            }
            onEdit={() => {}}
            compact={compact}
            isOverlay
          />
        ) : null}
      </DragOverlay>

      <style jsx>{`
        .pipeline-scroll {
          scroll-behavior: smooth;
        }
        @media (prefers-reduced-motion: reduce) {
          .pipeline-scroll {
            scroll-behavior: auto;
          }
        }
        /* On touch devices the peek/snap layout already signals there's
           more to swipe, so the scrollbar is hidden for a clean look.
           On desktop (mouse) the board can overflow with many stages
           and there is no peek hint, so keep a thin, themed scrollbar
           visible to make the overflow discoverable and usable. */
        @media (hover: none), (pointer: coarse) {
          .pipeline-scroll::-webkit-scrollbar {
            height: 0;
            display: none;
          }
          .pipeline-scroll {
            scrollbar-width: none;
          }
        }
        @media (hover: hover) and (pointer: fine) {
          .pipeline-scroll,
          :global(.stage-scroll) {
            scrollbar-width: thin;
            scrollbar-color: var(--border) transparent;
          }
          .pipeline-scroll::-webkit-scrollbar {
            height: 8px;
          }
          .pipeline-scroll::-webkit-scrollbar-track {
            background: transparent;
          }
          .pipeline-scroll::-webkit-scrollbar-thumb {
            background-color: var(--border);
            border-radius: 9999px;
          }
          .pipeline-scroll::-webkit-scrollbar-thumb:hover {
            background-color: var(--muted-foreground);
          }
        }
      `}</style>
    </DndContext>
  );
}

function StageColumn({
  stage,
  deals,
  totalValue,
  currency,
  compact,
  onAddDeal,
  onEditDeal,
  onStatus,
}: {
  stage: PipelineStage;
  deals: Deal[];
  totalValue: number;
  currency: string;
  compact: boolean;
  onAddDeal?: (stageId: string) => void;
  onEditDeal: (deal: Deal) => void;
  onStatus?: (deal: Deal, status: DealStatus) => void;
}) {
  // The droppable ref is on the card list below — intentionally not on
  // the column, so a drag over the stage header does not tint it.
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const { language } = useLanguage();
  const copy = COPY[language] ?? COPY["pt-BR"];

  return (
    // Mobile: each column is `w-[85vw]` so the next one peeks in, and
    // snap-start lands it cleanly when swiping. lg+: columns share the row.
    <section
      aria-label={copy.column(stage.name, deals.length)}
      className="flex w-[85vw] min-w-[260px] max-w-[320px] shrink-0 snap-start flex-col rounded-[var(--radius)] bg-muted/45 board-fit:min-h-0 lg:w-auto lg:min-w-[220px] lg:max-w-none lg:flex-1 lg:basis-[220px] lg:shrink lg:snap-none dark:bg-muted/30"
    >
      <header className="flex items-center gap-2 border-b border-border/70 px-3 py-2.5">
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: stage.color || "var(--muted-foreground)" }}
        />
        <h3 className="min-w-0 truncate text-[13px] font-semibold text-foreground">
          {stage.name}
        </h3>
        <span className="shrink-0 rounded-full bg-background px-1.5 py-px text-[11px] font-semibold tabular-nums text-muted-foreground">
          {deals.length}
        </span>
        <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
          {formatCurrency(totalValue, currency)}
        </span>
        {onAddDeal && (
          <button
            type="button"
            onClick={() => onAddDeal(stage.id)}
            aria-label={copy.addTo(stage.name)}
            title={copy.add}
            className="-mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          >
            <Plus className="size-3.5" aria-hidden />
          </button>
        )}
      </header>

      <div
        ref={setNodeRef}
        data-over={isOver || undefined}
        className={cn(
          "stage-scroll flex flex-1 flex-col rounded-b-[var(--radius)] p-2 transition-colors duration-150 motion-reduce:transition-none board-fit:min-h-0 board-fit:overflow-y-auto",
          compact ? "gap-1" : "gap-1.5",
          isOver && "bg-primary/8 ring-1 ring-inset ring-primary/35",
        )}
      >
        {deals.length === 0 ? (
          <div className="flex flex-1 flex-col items-start gap-1 px-1.5 py-3 text-xs text-muted-foreground">
            <p>{isOver ? copy.dropHere : copy.empty}</p>
            {onAddDeal && !isOver && (
              <button
                type="button"
                onClick={() => onAddDeal(stage.id)}
                className="inline-flex items-center gap-1 rounded-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Plus className="size-3" aria-hidden />
                {copy.add}
              </button>
            )}
          </div>
        ) : (
          deals.map((deal) => (
            <DraggableDealCard
              key={deal.id}
              deal={deal}
              stage={stage}
              compact={compact}
              onEdit={onEditDeal}
              onStatus={onStatus}
            />
          ))
        )}
      </div>
    </section>
  );
}

function DraggableDealCard({
  deal,
  stage,
  compact,
  onEdit,
  onStatus,
}: {
  deal: Deal;
  stage: PipelineStage;
  compact: boolean;
  onEdit: (deal: Deal) => void;
  onStatus?: (deal: Deal, status: DealStatus) => void;
}) {
  // The card's main button is the drag handle (activator): Space picks
  // it up, Enter / click opens it, and the quick-action buttons never
  // start a drag.
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } =
    useDraggable({ id: deal.id });

  return (
    <div ref={setNodeRef} className={cn(isDragging && "opacity-40")}>
      <DealCard
        deal={deal}
        stage={stage}
        compact={compact}
        onEdit={onEdit}
        onStatus={onStatus}
        handleRef={setActivatorNodeRef}
        handleProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
}
