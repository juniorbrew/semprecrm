"use client";

import { useMemo, useState } from "react";
import { Check, Loader2, Plus, X } from "lucide-react";
import { useLanguage } from "@/hooks/use-language";
import type { Language } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { rankTagSuggestions } from "@/lib/inbox/tag-suggestions";
import type { Tag } from "@/types";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SectionHeader } from "./panel-section";

// Same preset palette as Settings › Tags.
export const TAG_PALETTE = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444", "#06b6d4", "#f97316", "#ec4899"];

export type ContactTag = Tag & { contact_tag_id: string };

const COPY: Record<
  Language,
  {
    title: string;
    none: string;
    add: string;
    suggested: string;
    suggest: (name: string) => string;
    remove: (name: string) => string;
    noTagsToPick: string;
    newPlaceholder: string;
    create: string;
    color: (c: string) => string;
    loading: string;
    askAdmin: string;
  }
> = {
  "pt-BR": {
    title: "Etiquetas",
    none: "Sem etiquetas",
    add: "Adicionar etiqueta",
    suggested: "Mais usadas",
    suggest: (n) => `Adicionar etiqueta ${n}`,
    remove: (n) => `Remover etiqueta ${n}`,
    noTagsToPick: "Nenhuma etiqueta criada ainda. Digite um nome abaixo para criar a primeira.",
    newPlaceholder: "Nova etiqueta…",
    create: "Criar",
    color: (c) => `Cor ${c}`,
    loading: "Carregando etiquetas",
    askAdmin: "Peça a um administrador para criar novas etiquetas.",
  },
  "en-US": {
    title: "Labels",
    none: "No labels",
    add: "Add label",
    suggested: "Most used",
    suggest: (n) => `Add label ${n}`,
    remove: (n) => `Remove label ${n}`,
    noTagsToPick: "No labels yet. Type a name below to create the first one.",
    newPlaceholder: "New label…",
    create: "Create",
    color: (c) => `Color ${c}`,
    loading: "Loading labels",
    askAdmin: "Ask an administrator to create new labels.",
  },
};

interface PanelTagsProps {
  contactTags: ContactTag[];
  allTags: Tag[];
  /** tag id -> number of contacts using it (ranks the suggestions). */
  usage: Record<string, number>;
  loaded: boolean;
  canWrite: boolean;
  /** Creating a tag needs admin+ (tags_insert RLS); agents only pick existing ones. */
  canCreate: boolean;
  busyId: string | null;
  creating: boolean;
  onToggle: (tag: Tag) => void;
  onCreate: (name: string, color: string) => void;
}

export function PanelTags({
  contactTags,
  allTags,
  usage,
  loaded,
  canWrite,
  canCreate,
  busyId,
  creating,
  onToggle,
  onCreate,
}: PanelTagsProps) {
  const { language } = useLanguage();
  const copy = COPY[language] ?? COPY["pt-BR"];
  const [pickerOpen, setPickerOpen] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(null);

  const appliedIds = useMemo(() => new Set(contactTags.map((t) => t.id)), [contactTags]);
  const suggestions = useMemo(
    () => (canWrite ? rankTagSuggestions(allTags, usage, appliedIds) : []),
    [canWrite, allTags, usage, appliedIds],
  );
  const chosenColor = color ?? TAG_PALETTE[allTags.length % TAG_PALETTE.length];

  return (
    <div>
      <SectionHeader
        label={copy.title}
        count={contactTags.length}
        action={
          canWrite ? (
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger
                aria-label={copy.add}
                title={copy.add}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
              </PopoverTrigger>
              <PopoverContent align="end" className="w-56 border-border bg-popover p-1.5">
                {allTags.length === 0 ? (
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">{copy.noTagsToPick}</p>
                ) : (
                  <ul className="max-h-56 overflow-y-auto">
                    {allTags.map((tag) => {
                      const selected = appliedIds.has(tag.id);
                      return (
                        <li key={tag.id}>
                          <button
                            type="button"
                            disabled={!!busyId}
                            onClick={() => onToggle(tag)}
                            aria-pressed={selected}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-popover-foreground transition-colors hover:bg-muted disabled:opacity-60"
                          >
                            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
                            <span className="flex-1 truncate">{tag.name}</span>
                            {busyId === tag.id ? (
                              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                            ) : selected ? (
                              <Check className="h-3 w-3 text-primary" />
                            ) : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {!canCreate ? (
                  <p className="mt-1 border-t border-border px-2 pt-1.5 text-[11px] text-muted-foreground">
                    {copy.askAdmin}
                  </p>
                ) : (
                <form
                  className="mt-1 space-y-1.5 border-t border-border pt-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const trimmed = name.trim();
                    if (!trimmed || creating) return;
                    onCreate(trimmed, chosenColor);
                    setName("");
                    setColor(null);
                  }}
                >
                  <div className="flex items-center gap-1">
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={copy.newPlaceholder}
                      maxLength={40}
                      disabled={creating}
                      aria-label={copy.newPlaceholder}
                      className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
                    />
                    <button
                      type="submit"
                      disabled={creating || !name.trim()}
                      className="inline-flex h-7 shrink-0 items-center rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground disabled:opacity-50"
                    >
                      {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : copy.create}
                    </button>
                  </div>
                  <div role="radiogroup" aria-label={copy.color("")} className="flex flex-wrap gap-1 px-0.5">
                    {TAG_PALETTE.map((c) => (
                      <button
                        key={c}
                        type="button"
                        role="radio"
                        aria-checked={c === chosenColor}
                        aria-label={copy.color(c)}
                        onClick={() => setColor(c)}
                        className={cn(
                          "h-4 w-4 rounded-full ring-offset-1 ring-offset-popover transition-shadow",
                          c === chosenColor && "ring-2 ring-foreground/60",
                        )}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                </form>
                )}
              </PopoverContent>
            </Popover>
          ) : undefined
        }
      />
      <div className="mt-2 px-1">
        {!loaded ? (
          <div role="status" aria-label={copy.loading} className="h-5 w-24 animate-pulse rounded-full bg-muted/60" />
        ) : (
          <>
            <div className="flex flex-wrap gap-1">
              {contactTags.length === 0 ? (
                <p className="text-xs text-muted-foreground">{copy.none}</p>
              ) : (
                contactTags.map((tag) => (
                  <button
                    key={tag.contact_tag_id}
                    type="button"
                    onClick={() => onToggle(tag)}
                    disabled={!canWrite || !!busyId}
                    title={copy.remove(tag.name)}
                    aria-label={copy.remove(tag.name)}
                    className="group/tag inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-foreground transition-colors hover:bg-muted disabled:opacity-60"
                  >
                    <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tag.color }} />
                    {tag.name}
                    {canWrite && <X className="h-2.5 w-2.5 opacity-60 group-hover/tag:opacity-100" aria-hidden />}
                  </button>
                ))
              )}
            </div>
            {suggestions.length > 0 && (
              <div className="mt-2">
                <p className="mb-1 text-xs text-muted-foreground">{copy.suggested}</p>
                <div className="flex flex-wrap gap-1">
                  {suggestions.map((tag) => (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => onToggle(tag)}
                      disabled={!!busyId}
                      title={copy.suggest(tag.name)}
                      aria-label={copy.suggest(tag.name)}
                      className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60"
                    >
                      <Plus className="size-3" aria-hidden />
                      {tag.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
