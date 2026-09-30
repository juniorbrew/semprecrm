"use client";

import { useState } from "react";
import { UserPlus } from "lucide-react";
import { useLanguage } from "@/hooks/use-language";
import { MAX_TRANSFER_REASON, normalizeTransferReason } from "@/lib/conversations/transfer-reason";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

interface TransferDialogProps {
  /** Teammate the conversation goes to; null keeps the dialog closed. */
  targetName: string | null;
  onCancel: () => void;
  /** `reason` is already normalised (null = none given). */
  onConfirm: (reason: string | null) => void;
  busy?: boolean;
}

/** "Transferir" step: optional short reason (≤ 200 chars) that travels with the hand-over. */
export function TransferDialog({ targetName, onCancel, onConfirm, busy }: TransferDialogProps) {
  const { t } = useLanguage();
  const [reason, setReason] = useState("");
  return (
    <Dialog
      open={targetName !== null}
      onOpenChange={(open) => {
        if (!open) {
          setReason("");
          onCancel();
        }
      }}
    >
      <DialogContent data-testid="transfer-dialog">
        <DialogHeader>
          <DialogTitle>{t("Transfer conversation")}</DialogTitle>
          <DialogDescription>
            {t("To")} <span data-no-translate className="font-medium text-foreground">{targetName}</span>
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <label htmlFor="transfer-reason" className="text-xs font-medium text-muted-foreground">
            {t("Reason (optional)")}
          </label>
          <Textarea
            id="transfer-reason"
            value={reason}
            maxLength={MAX_TRANSFER_REASON}
            rows={3}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("Context for the new owner…")}
            data-no-translate
          />
          <span className="self-end text-[11px] tabular-nums text-muted-foreground" data-no-translate>
            {reason.length}/{MAX_TRANSFER_REASON}
          </span>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setReason("");
              onCancel();
            }}
          >
            {t("Cancel")}
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              const value = normalizeTransferReason(reason);
              setReason("");
              onConfirm(value);
            }}
          >
            <UserPlus />
            {t("Transfer")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
