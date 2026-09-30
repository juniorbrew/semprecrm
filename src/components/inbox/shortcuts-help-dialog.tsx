"use client";

import { useLanguage } from "@/hooks/use-language";
import { SHORTCUT_HELP } from "@/lib/inbox/shortcuts";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function ShortcutsHelpDialog({
  open,
  onOpenChange,
  enabled,
  onEnabledChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const { t } = useLanguage();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="shortcuts-help">
        <DialogHeader>
          <DialogTitle>{t("Keyboard shortcuts")}</DialogTitle>
        </DialogHeader>
        <ul className="grid gap-1.5">
          {SHORTCUT_HELP.map((row) => (
            <li key={row.label} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">{t(row.label)}</span>
              <span className="flex shrink-0 items-center gap-1" data-no-translate>
                {row.keys.map((k) => (
                  <kbd
                    key={k}
                    className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-sans text-[11px] font-medium text-foreground"
                  >
                    {k}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
        <label className="flex items-center justify-between gap-3 border-t border-border pt-3 text-sm">
          <span>{t("Keyboard shortcuts")}</span>
          <Switch checked={enabled} onCheckedChange={onEnabledChange} aria-label={t("Keyboard shortcuts")} />
        </label>
      </DialogContent>
    </Dialog>
  );
}
