"use client";

import { useState } from "react";
import { useLanguage } from "@/hooks/use-language";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Lock } from "lucide-react";

interface TeamNoteComposerProps {
  /** Resolves when the note is stored; rejects to keep the draft. */
  onSubmit: (text: string) => Promise<void>;
  onCancel: () => void;
}

/**
 * Inline note box revealed by the panel's "Notas da equipe" +. Ctrl/Cmd+
 * Enter or "Salvar" submits, Esc / "Cancelar" collapses. The parent owns
 * the write (shared with the composer's Nota interna tab).
 */
export function TeamNoteComposer({ onSubmit, onCancel }: TeamNoteComposerProps) {
  const { t } = useLanguage();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  const canSave = text.trim().length > 0 && !saving;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      await onSubmit(text.trim());
      setText("");
    } catch {
      // Parent already toasted; keep the draft so nothing is lost.
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-dashed border-amber-500/40 bg-amber-500/10 p-2">
      <Textarea
        value={text}
        autoFocus
        disabled={saving}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder={t("Write a note for the team…")}
        aria-label={t("Team note")}
        rows={3}
        className="min-h-16 border-transparent bg-background/60 text-xs text-foreground focus-visible:ring-amber-500/40 md:text-xs"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
          <Lock className="h-3 w-3" />
          {t("Team only")}
        </span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={saving}
            className="h-7 px-2 text-xs text-muted-foreground hover:bg-muted"
          >
            {t("Cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void save()}
            disabled={!canSave}
            title={t("Ctrl+Enter to save")}
            className="h-7 bg-primary px-2.5 text-xs text-primary-foreground hover:bg-primary/90"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : t("Save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
