"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Search, Users } from "lucide-react";

import { cn } from "@/lib/utils";
import { useLanguage } from "@/hooks/use-language";
import { memberDisplayName } from "@/lib/chat";
import type { ChatMember } from "@/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export const GROUP_TITLE_MAX = 80;

interface GroupMembersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `create`: title + members → new group. `add`: members only, into an existing group. */
  mode: "create" | "add";
  /** Every account member (me included — I am filtered out). */
  members: ChatMember[];
  userId: string;
  /** Ids already in the group (hidden in `add` mode). */
  excludeIds?: readonly string[];
  isOnline: (userId: string) => boolean;
  onSubmit: (input: { title: string; memberIds: string[] }) => Promise<void>;
}

function normalize(s: string): string {
  return s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().trim();
}

/**
 * "Novo grupo" (title + multi-select) and "Adicionar membros"
 * (multi-select only) share this dialog. Search filters by name /
 * email; the submit button stays disabled until the form is valid.
 */
export function GroupMembersDialog({
  open,
  onOpenChange,
  mode,
  members,
  userId,
  excludeIds = [],
  isOnline,
  onSubmit,
}: GroupMembersDialogProps) {
  const { t } = useLanguage();
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);

  // Fresh form each time it opens.
  useEffect(() => {
    if (open) {
      setTitle("");
      setQuery("");
      setSelected(new Set());
      setBusy(false);
    }
  }, [open]);

  const candidates = useMemo(() => {
    const excluded = new Set(excludeIds);
    const q = normalize(query);
    return members
      .filter((m) => m.user_id !== userId && !excluded.has(m.user_id))
      .filter((m) => !q || normalize(memberDisplayName(m)).includes(q) || normalize(m.email).includes(q))
      .sort((a, b) => memberDisplayName(a).localeCompare(memberDisplayName(b), undefined, { sensitivity: "base" }));
  }, [members, userId, excludeIds, query]);

  const nobodyLeft = members.filter((m) => m.user_id !== userId && !excludeIds.includes(m.user_id)).length === 0;
  const titleOk = mode === "add" || title.trim().length > 0;
  const canSubmit = !busy && titleOk && selected.size > 0;

  const toggle = (id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onSubmit({ title: title.trim(), memberIds: [...selected] });
      onOpenChange(false);
    } catch {
      // The caller toasts; keep the dialog open so the user can retry.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-popover-foreground">
            <Users className="size-4 text-primary" />
            {mode === "create" ? t("New group") : t("Add members")}
          </DialogTitle>
          <DialogDescription>{t("Pick the teammates for this group.")}</DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {mode === "create" ? (
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, GROUP_TITLE_MAX))}
              placeholder={t("Group name")}
              aria-label={t("Group name")}
              maxLength={GROUP_TITLE_MAX}
              autoFocus
            />
          ) : null}

          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("Search people")}
              aria-label={t("Search people")}
              className="h-9 pl-8"
            />
          </div>

          <ul className="max-h-64 overflow-y-auto rounded-md border border-border" aria-label={t("Members")}>
            {nobodyLeft ? (
              <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                {mode === "add" ? t("Everyone is already in this group.") : t("No other members in your account yet.")}
              </li>
            ) : candidates.length === 0 ? (
              <li className="px-3 py-6 text-center text-sm text-muted-foreground">{t("No one matches your search.")}</li>
            ) : (
              candidates.map((m) => {
                const name = memberDisplayName(m);
                const checked = selected.has(m.user_id);
                const online = isOnline(m.user_id);
                return (
                  <li key={m.user_id}>
                    <label
                      className={cn(
                        "flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors hover:bg-muted/60",
                        checked && "bg-primary/5",
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => toggle(m.user_id, v === true)}
                        aria-label={name}
                      />
                      <span className="relative shrink-0">
                        <Avatar className="size-8">
                          {m.avatar_url ? <AvatarImage src={m.avatar_url} alt={name} /> : null}
                          <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">
                            {name.charAt(0).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <span
                          className={cn(
                            "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-popover",
                            online ? "bg-emerald-500" : "bg-muted-foreground/50",
                          )}
                        />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">{name}</span>
                        <span className="block truncate text-xs text-muted-foreground">{m.email}</span>
                      </span>
                    </label>
                  </li>
                );
              })
            )}
          </ul>

          <p className="text-xs text-muted-foreground" aria-live="polite">
            {selected.size === 0
              ? t("Select at least one member.")
              : `${selected.size} ${selected.size === 1 ? t("member") : t("members")}`}
          </p>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              {t("Cancel")}
            </Button>
            <Button type="submit" disabled={!canSubmit} className="bg-primary text-primary-foreground hover:bg-primary/90">
              {busy ? <Loader2 className="size-4 animate-spin" /> : mode === "create" ? t("Create group") : t("Add")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
