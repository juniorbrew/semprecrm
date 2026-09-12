"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useLanguage } from "@/hooks/use-language";
import type { Conversation, Deal, DealStatus, PipelineStage } from "@/types";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import {
  findConversationByContact,
  findConversationById,
} from "@/lib/conversations/find-by-contact";
import { movedToLabel } from "@/lib/pipelines/deal-dates";
import { DealDetails } from "./deal-details";
import { DealFormBody } from "./deal-form";

interface DealDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The deal being viewed. Comes from the board's live list so status
   *  and stage changes made here are reflected after a refetch. */
  deal: Deal | null;
  pipelineId: string;
  stages: PipelineStage[];
  /** Refetch deals (after status / stage / save / delete). */
  onChanged: () => void | Promise<void>;
  /** Optimistic stage move shared with drag-and-drop on the board. */
  onDealMoved: (dealId: string, newStageId: string) => void | Promise<void>;
}

type Mode = "view" | "edit";
type Busy = "won" | "lost" | "open" | "advance" | null;

/**
 * Right-hand sheet for an existing deal. Opens on the read view
 * (identity, value, stage, contact + conversation, notes, timeline,
 * with Ganho / Perdido / next-stage in the header); "Editar" flips
 * the same sheet to the form.
 */
export function DealDrawer({
  open,
  onOpenChange,
  deal,
  pipelineId,
  stages,
  onChanged,
  onDealMoved,
}: DealDrawerProps) {
  const supabase = createClient();
  const { t, language } = useLanguage();

  const [mode, setMode] = useState<Mode>("view");
  const [busy, setBusy] = useState<Busy>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [conversationLoading, setConversationLoading] = useState(false);

  const dealId = deal?.id ?? null;
  const contactId = deal?.contact_id ?? null;
  const linkedConversationId = deal?.conversation_id ?? null;

  // Always land on the read view when a (different) deal opens.
  useEffect(() => {
    if (open) setMode("view");
  }, [open, dealId]);

  // Resolve "the contact's conversation": the one explicitly linked to
  // the deal when there is one, otherwise the contact's most recent.
  useEffect(() => {
    if (!open || !dealId) return;
    let cancelled = false;
    setConversationLoading(true);
    (async () => {
      let found: Conversation | null = null;
      if (linkedConversationId) {
        found = await findConversationById(supabase, linkedConversationId);
      }
      if (!found && contactId) {
        found = await findConversationByContact(supabase, contactId);
      }
      if (cancelled) return;
      setConversation(found);
      setConversationLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, dealId, contactId, linkedConversationId, supabase]);

  async function handleStatus(status: DealStatus) {
    if (!deal) return;
    setBusy(status);
    const { error } = await supabase
      .from("deals")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", deal.id);
    setBusy(null);
    if (error) {
      toast.error(t("Failed to update deal status"));
      return;
    }
    toast.success(
      status === "won"
        ? t("Marked as won")
        : status === "lost"
          ? t("Marked as lost")
          : t("Deal reopened"),
    );
    await onChanged();
  }

  async function handleAdvance(stage: PipelineStage) {
    if (!deal) return;
    setBusy("advance");
    try {
      await onDealMoved(deal.id, stage.id);
      toast.success(movedToLabel(stage.name, language));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full border-border bg-popover p-0 text-popover-foreground data-[side=right]:sm:max-w-[480px]"
        aria-describedby={undefined}
      >
        {deal && mode === "view" && (
          <DealDetails
            key={deal.id}
            deal={deal}
            stages={stages}
            conversation={conversation}
            conversationLoading={conversationLoading}
            busy={busy}
            onEdit={() => setMode("edit")}
            onStatus={handleStatus}
            onAdvance={handleAdvance}
          />
        )}

        {deal && mode === "edit" && (
          <div className="flex h-full flex-col">
            <SheetHeader className="flex-row items-center gap-2 border-b border-border/50 p-3 pr-12">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setMode("view")}
                aria-label={t("Back to deal")}
                title={t("Back to deal")}
                className="text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft />
              </Button>
              <SheetTitle className="text-popover-foreground">
                {t("Edit deal")}
              </SheetTitle>
            </SheetHeader>
            <DealFormBody
              key={`${deal.id}-${deal.updated_at ?? ""}`}
              deal={deal}
              pipelineId={pipelineId}
              stages={stages}
              onSaved={async () => {
                await onChanged();
                setMode("view");
              }}
              onCancel={() => setMode("view")}
              onDeleted={() => onOpenChange(false)}
              cancelLabel={t("Back to deal")}
            />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
