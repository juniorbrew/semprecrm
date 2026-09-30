"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import { notifyCategoriesChanged } from "@/hooks/use-conversation-categories";
import { notifyTriageSettingsChanged, useTriageSettings } from "@/hooks/use-triage-settings";
import { createClient } from "@/lib/supabase/client";
import {
  CategoryNameTakenError,
  createCategory,
  listCategories,
  updateCategory,
} from "@/lib/support/categories";
import {
  CATEGORY_COLORS,
  CATEGORY_DOT,
  CATEGORY_LIMITS,
  PRIORITIES,
  activeCategories,
  supportCopy,
  type CategoryColor,
  type ConversationCategory,
} from "@/lib/support/model";
import type { Language } from "@/lib/i18n";
import type { ConversationPriority } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { SettingsGroup } from "./settings-group";
import { SettingsPanelHead } from "./settings-panel-head";
import { SlaSettings } from "./support-sla-settings";
import { RoutingSettings, TeamsSettings } from "./support-teams-settings";

const COPY: Record<
  Language,
  {
    title: string;
    intro: string;
    categories: string;
    categoriesHint: string;
    empty: string;
    name: string;
    namePlaceholder: string;
    description: string;
    descriptionPlaceholder: string;
    color: string;
    defaultPriority: string;
    add: string;
    archive: string;
    restore: string;
    showArchived: (n: number) => string;
    hideArchived: string;
    taken: string;
    readOnly: string;
    auto: string;
    autoBody: string;
    autoNeedsAi: string;
    autoNeedsRow: string;
    autoNeedsCategory: string;
  }
> = {
  "pt-BR": {
    title: "Suporte",
    intro: "Categorias e classificação das conversas de atendimento.",
    categories: "Categorias",
    categoriesHint: "A descrição ajuda a IA a escolher a categoria certa.",
    empty: "Nenhuma categoria ainda. Adicione a primeira abaixo.",
    name: "Nome da categoria",
    namePlaceholder: "Nome",
    description: "Descrição",
    descriptionPlaceholder: "Quando usar esta categoria",
    color: "Cor",
    defaultPriority: "Prioridade padrão",
    add: "Adicionar",
    archive: "Arquivar",
    restore: "Restaurar",
    showArchived: (n) => `Arquivadas (${n})`,
    hideArchived: "Ocultar arquivadas",
    taken: "Já existe uma categoria com esse nome",
    readOnly: "Somente administradores podem alterar as categorias.",
    auto: "Classificar automaticamente",
    autoBody:
      "A IA lê as últimas mensagens e sugere categoria, prioridade e assunto na primeira e na terceira mensagem do cliente. O texto é enviado ao provedor de IA da conta e conta no orçamento mensal de IA.",
    autoNeedsAi: "Ative a IA em Configurações > Inteligência Artificial para usar.",
    autoNeedsRow: "Salve as configurações de IA primeiro.",
    autoNeedsCategory: "Crie ao menos uma categoria para a IA escolher.",
  },
  "en-US": {
    title: "Support",
    intro: "Categories and triage for support conversations.",
    categories: "Categories",
    categoriesHint: "The description helps the AI pick the right category.",
    empty: "No categories yet. Add the first one below.",
    name: "Category name",
    namePlaceholder: "Name",
    description: "Description",
    descriptionPlaceholder: "When to use this category",
    color: "Color",
    defaultPriority: "Default priority",
    add: "Add",
    archive: "Archive",
    restore: "Restore",
    showArchived: (n) => `Archived (${n})`,
    hideArchived: "Hide archived",
    taken: "A category with this name already exists",
    readOnly: "Only admins can change categories.",
    auto: "Classify automatically",
    autoBody:
      "The AI reads the latest messages and suggests a category, priority and subject on the customer's first and third message. The text is sent to the account's AI provider and counts toward the monthly AI budget.",
    autoNeedsAi: "Turn on AI in Settings > Artificial Intelligence to use this.",
    autoNeedsRow: "Save the AI settings first.",
    autoNeedsCategory: "Create at least one category for the AI to choose from.",
  },
};

/**
 * Settings → Suporte (admin): the account's conversation categories and the
 * opt-in for automatic triage. Plain list; edits save when a field loses
 * focus. RLS limits writes to admins, the UI mirrors it.
 */
export function SupportSettings() {
  const { language } = useLanguage();
  const copy = COPY[language] ?? COPY["pt-BR"];
  const shared = supportCopy(language);
  const { accountId, canEditSettings, profileLoading } = useAuth();
  const readOnly = !canEditSettings;

  const [rows, setRows] = useState<ConversationCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);

  async function reload() {
    if (!accountId) return;
    try {
      setRows(await listCategories(createClient(), accountId));
    } catch (err) {
      console.error(err);
      toast.error(shared.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    listCategories(createClient(), accountId)
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch((err) => console.error(err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const live = useMemo(() => activeCategories(rows), [rows]);
  const archived = useMemo(() => rows.filter((r) => r.archived_at), [rows]);

  async function patch(
    id: string,
    changes: Partial<Pick<ConversationCategory, "name" | "description" | "color" | "default_priority">> & {
      archived?: boolean;
    },
  ) {
    try {
      await updateCategory(createClient(), id, changes);
      notifyCategoriesChanged();
    } catch (err) {
      toast.error(err instanceof CategoryNameTakenError ? copy.taken : shared.saveFailed);
    }
    await reload();
  }

  async function handleAdd() {
    if (!accountId || !newName.trim()) return;
    setAdding(true);
    try {
      await createCategory(createClient(), accountId, rows, { name: newName });
      setNewName("");
      notifyCategoriesChanged();
      await reload();
    } catch (err) {
      toast.error(err instanceof CategoryNameTakenError ? copy.taken : shared.saveFailed);
    } finally {
      setAdding(false);
    }
  }

  return (
    <div>
      <SettingsPanelHead title={copy.title} description={copy.intro} />

      <div className="space-y-8">
      <SettingsGroup title={copy.categories} description={copy.categoriesHint}>
        <div>
          {loading || profileLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-14 animate-pulse rounded-lg bg-muted/60" />
              ))}
            </div>
          ) : (
            <>
              {live.length === 0 && <p className="py-2 text-sm text-muted-foreground">{copy.empty}</p>}
              <ul>
                {live.map((cat) => (
                  <CategoryRow key={cat.id} cat={cat} readOnly={readOnly} copy={copy} priorityNames={shared.priorities} onPatch={patch} />
                ))}
              </ul>

              {!readOnly && (
                <form
                  className="mt-4 flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleAdd();
                  }}
                >
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder={copy.namePlaceholder}
                    aria-label={copy.name}
                    maxLength={CATEGORY_LIMITS.name}
                    className="h-8 max-w-64 text-sm"
                  />
                  <Button type="submit" size="sm" variant="outline" disabled={adding || !newName.trim()}>
                    {copy.add}
                  </Button>
                </form>
              )}
              {readOnly && <p className="mt-3 text-xs text-muted-foreground">{copy.readOnly}</p>}

              {archived.length > 0 && (
                <div className="mt-5">
                  <button
                    type="button"
                    onClick={() => setShowArchived((v) => !v)}
                    aria-expanded={showArchived}
                    className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {showArchived ? copy.hideArchived : copy.showArchived(archived.length)}
                  </button>
                  {showArchived && (
                    <ul className="mt-2">
                      {archived.map((cat) => (
                        <li key={cat.id} className="flex items-center gap-2 py-1.5 text-sm text-muted-foreground">
                          <span className={cn("h-2 w-2 shrink-0 rounded-full opacity-60", CATEGORY_DOT[cat.color])} aria-hidden />
                          <span className="flex-1 truncate">{cat.name}</span>
                          {!readOnly && (
                            <Button type="button" variant="ghost" size="xs" onClick={() => void patch(cat.id, { archived: false })}>
                              {copy.restore}
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </SettingsGroup>

      <AutoTriage copy={copy} readOnly={readOnly} hasCategories={live.length > 0} />
      <SlaSettings readOnly={readOnly} />
      <TeamsSettings readOnly={readOnly} />
      <RoutingSettings readOnly={readOnly} />
      </div>
    </div>
  );
}

function CategoryRow({
  cat,
  readOnly,
  copy,
  priorityNames,
  onPatch,
}: {
  cat: ConversationCategory;
  readOnly: boolean;
  copy: (typeof COPY)["pt-BR"];
  priorityNames: Record<ConversationPriority, string>;
  onPatch: (
    id: string,
    changes: Partial<Pick<ConversationCategory, "name" | "description" | "color" | "default_priority">> & {
      archived?: boolean;
    },
  ) => Promise<void>;
}) {
  const [name, setName] = useState(cat.name);
  const [description, setDescription] = useState(cat.description ?? "");

  useEffect(() => {
    // Mirror server values after a reload (e.g. a rejected rename).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setName(cat.name);
    setDescription(cat.description ?? "");
  }, [cat.name, cat.description]);

  return (
    <li className="flex items-start gap-3 border-b border-border/60 py-3 last:border-b-0">
      <Popover>
        <PopoverTrigger
          disabled={readOnly}
          aria-label={copy.color}
          title={copy.color}
          className="mt-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full hover:bg-muted disabled:cursor-default"
        >
          <span className={cn("h-2.5 w-2.5 rounded-full", CATEGORY_DOT[cat.color])} />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto flex-row gap-1.5 p-2">
          {CATEGORY_COLORS.map((color: CategoryColor) => (
            <button
              key={color}
              type="button"
              aria-label={color}
              aria-pressed={cat.color === color}
              onClick={() => void onPatch(cat.id, { color })}
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full hover:bg-muted",
                cat.color === color && "bg-muted",
              )}
            >
              <span className={cn("h-2.5 w-2.5 rounded-full", CATEGORY_DOT[color])} />
            </button>
          ))}
        </PopoverContent>
      </Popover>

      <div className="min-w-0 flex-1 space-y-1">
        <Input
          value={name}
          disabled={readOnly}
          maxLength={CATEGORY_LIMITS.name}
          aria-label={copy.name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            const next = name.trim();
            if (!next) setName(cat.name);
            else if (next !== cat.name) void onPatch(cat.id, { name: next });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="h-8 border-transparent bg-transparent px-2 text-sm font-medium shadow-none hover:border-border focus:border-border"
        />
        <Input
          value={description}
          disabled={readOnly}
          maxLength={CATEGORY_LIMITS.description}
          aria-label={copy.description}
          placeholder={copy.descriptionPlaceholder}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => {
            if (description.trim() !== (cat.description ?? "")) void onPatch(cat.id, { description });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="h-7 border-transparent bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:border-border focus:border-border"
        />
      </div>

      <select
        value={cat.default_priority}
        disabled={readOnly}
        aria-label={copy.defaultPriority}
        title={copy.defaultPriority}
        onChange={(e) => void onPatch(cat.id, { default_priority: e.target.value as ConversationPriority })}
        className="mt-0.5 h-8 rounded-md border border-border bg-transparent px-2 text-xs text-foreground disabled:opacity-60"
      >
        {PRIORITIES.map((p) => (
          <option key={p} value={p}>
            {priorityNames[p]}
          </option>
        ))}
      </select>

      {!readOnly && (
        <Button type="button" variant="ghost" size="sm" className="mt-0.5 text-muted-foreground" onClick={() => void onPatch(cat.id, { archived: true })}>
          {copy.archive}
        </Button>
      )}
    </li>
  );
}

function AutoTriage({
  copy,
  readOnly,
  hasCategories,
}: {
  copy: (typeof COPY)["pt-BR"];
  readOnly: boolean;
  hasCategories: boolean;
}) {
  const { accountId } = useAuth();
  const shared = supportCopy(useLanguage().language);
  const { aiEnabled, triageEnabled, loaded, refresh } = useTriageSettings();
  const [saving, setSaving] = useState(false);

  async function toggle(next: boolean) {
    if (!accountId) return;
    setSaving(true);
    try {
      const { data, error } = await createClient()
        .from("ai_settings")
        .update({ triage_enabled: next })
        .eq("account_id", accountId)
        .select("account_id");
      if (error) throw error;
      if (!data?.length) {
        toast.error(copy.autoNeedsRow);
      } else {
        notifyTriageSettingsChanged();
      }
    } catch (err) {
      console.error(err);
      toast.error(shared.saveFailed);
    } finally {
      setSaving(false);
      refresh();
    }
  }

  const hint = !aiEnabled ? copy.autoNeedsAi : !hasCategories ? copy.autoNeedsCategory : null;

  return (
    <SettingsGroup
      title={<span id="support-auto">{copy.auto}</span>}
      description={copy.autoBody}
      action={
        <Switch
          checked={triageEnabled}
          disabled={readOnly || saving || !loaded || !aiEnabled}
          onCheckedChange={(v) => void toggle(v)}
          aria-labelledby="support-auto"
        />
      }
    >
      {loaded && hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </SettingsGroup>
  );
}
