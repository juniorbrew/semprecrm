"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  BookOpen,
  FileText,
  FileUp,
  Loader2,
  MessageCircleQuestion,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";

import { useLanguage } from "@/hooks/use-language";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  KB_FILE_EXTENSIONS,
  KB_LIMITS,
  type KbItem,
  type KbItemSummary,
  type KbKind,
  type KbSearchHit,
} from "@/lib/ai/knowledge";
import { SettingsChip } from "./settings-chip";

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `HTTP ${res.status}`;
}

interface Draft {
  id: string | null;
  kind: KbKind;
  title: string;
  question: string;
  content: string;
}

const KIND_ICON: Record<KbKind, typeof FileText> = {
  faq: MessageCircleQuestion,
  text: FileText,
  file: FileUp,
};

/**
 * Settings → Inteligência Artificial → Base de conhecimento (admin+).
 * FAQs, texts and uploaded files the "Sugerir resposta" feature searches
 * before writing a suggestion. Rendered inside AiSettings, which already
 * gates on role and plan module.
 */
export function AiKnowledge() {
  const { t, language } = useLanguage();
  const [items, setItems] = useState<KbItemSummary[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<KbSearchHit[] | null>(null);

  const num = useMemo(() => new Intl.NumberFormat(language), [language]);
  const kindLabel: Record<KbKind, string> = { faq: t("FAQ"), text: t("Text"), file: t("File") };

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const res = await fetch("/api/ai/knowledge", { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res));
      setItems(((await res.json()) as { items: KbItemSummary[] }).items);
    } catch (err) {
      console.error("[ai-knowledge] load failed:", err);
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function openEdit(item: KbItemSummary) {
    setBusyId(item.id);
    try {
      const res = await fetch(`/api/ai/knowledge/${item.id}`, { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res));
      const full = ((await res.json()) as { item: KbItem }).item;
      setDraft({ id: full.id, kind: full.kind, title: full.title, question: full.question ?? "", content: full.content });
    } catch (err) {
      toast.error(t(err instanceof Error ? err.message : "Could not load the item"));
    } finally {
      setBusyId(null);
    }
  }

  async function saveDraft() {
    if (!draft) return;
    setSaving(true);
    try {
      const body = {
        kind: draft.kind,
        // A FAQ is titled by its question.
        title: draft.kind === "faq" ? draft.question : draft.title,
        question: draft.question,
        content: draft.content,
      };
      const res = await fetch(draft.id ? `/api/ai/knowledge/${draft.id}` : "/api/ai/knowledge", {
        method: draft.id ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await readError(res));
      toast.success(t("Knowledge base updated"));
      setDraft(null);
      await load();
    } catch (err) {
      toast.error(t(err instanceof Error ? err.message : "Failed to save the knowledge item"));
    } finally {
      setSaving(false);
    }
  }

  async function upload(file: File) {
    setUploading(true);
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch("/api/ai/knowledge", { method: "POST", body: form });
      if (!res.ok) throw new Error(await readError(res));
      toast.success(t("File added to the knowledge base"));
      await load();
    } catch (err) {
      toast.error(t(err instanceof Error ? err.message : "Failed to save the knowledge item"));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function toggle(item: KbItemSummary, enabled: boolean) {
    setBusyId(item.id);
    setItems((prev) => prev?.map((i) => (i.id === item.id ? { ...i, enabled } : i)) ?? prev);
    try {
      const res = await fetch(`/api/ai/knowledge/${item.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error(await readError(res));
    } catch (err) {
      setItems((prev) => prev?.map((i) => (i.id === item.id ? { ...i, enabled: !enabled } : i)) ?? prev);
      toast.error(t(err instanceof Error ? err.message : "Failed to save the knowledge item"));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(item: KbItemSummary) {
    if (!window.confirm(t("Delete this item from the knowledge base?"))) return;
    setBusyId(item.id);
    try {
      const res = await fetch(`/api/ai/knowledge/${item.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res));
      setItems((prev) => prev?.filter((i) => i.id !== item.id) ?? prev);
      toast.success(t("Item deleted"));
    } catch (err) {
      toast.error(t(err instanceof Error ? err.message : "Could not delete the item"));
    } finally {
      setBusyId(null);
    }
  }

  async function search() {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const res = await fetch("/api/ai/knowledge/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setHits(((await res.json()) as { hits: KbSearchHit[] }).hits);
    } catch (err) {
      toast.error(t(err instanceof Error ? err.message : "The search failed"));
    } finally {
      setSearching(false);
    }
  }

  const contentMax = draft?.kind === "file" ? KB_LIMITS.fileContentMaxChars : KB_LIMITS.contentMaxChars;
  const draftValid =
    !!draft &&
    draft.content.trim().length > 0 &&
    draft.content.length <= contentMax &&
    (draft.kind === "faq" ? draft.question.trim().length > 0 : draft.title.trim().length > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <BookOpen className="size-4 text-primary" />
          {t("Knowledge base")}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t(
            "Questions and answers, texts and files the assistant looks up before suggesting a reply — prices, opening hours, policies. Only the snippets that match the customer's latest messages are sent to the AI provider.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDraft({ id: null, kind: "faq", title: "", question: "", content: "" })}
          >
            <Plus className="mr-1.5 size-3.5" />
            {t("Add question")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDraft({ id: null, kind: "text", title: "", question: "", content: "" })}
          >
            <Plus className="mr-1.5 size-3.5" />
            {t("Add text")}
          </Button>
          <Button size="sm" variant="outline" disabled={uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <FileUp className="mr-1.5 size-3.5" />}
            {uploading ? t("Reading file…") : t("Upload file")}
          </Button>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept={KB_FILE_EXTENSIONS.map((e) => `.${e}`).join(",")}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
          <p className="w-full text-xs text-muted-foreground">
            {t("Files: .txt, .md, .csv or .pdf with text (scanned PDFs are not read), up to 5 MB.")}
          </p>
        </div>

        {loadError ? (
          <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-sm text-muted-foreground">
            {t("Could not load the knowledge base")}
            <Button size="sm" variant="outline" onClick={() => void load()}>
              {t("Try again")}
            </Button>
          </div>
        ) : items === null ? (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-muted/60" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            {t("The knowledge base is empty. Add your most frequent questions first.")}
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {items.map((item) => {
              const Icon = KIND_ICON[item.kind];
              return (
                <li key={item.id} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center">
                  <div className="flex min-w-0 flex-1 items-center gap-2.5">
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground" data-no-translate>
                        {item.title}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <SettingsChip variant="muted">{kindLabel[item.kind]}</SettingsChip>
                        <span>
                          {num.format(item.content_chars)} {t("characters")}
                        </span>
                        {item.source_filename ? (
                          <span className="truncate" data-no-translate>
                            · {item.source_filename}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Switch
                      checked={item.enabled}
                      disabled={busyId === item.id}
                      onCheckedChange={(v) => void toggle(item, v)}
                      aria-label={`${t("Use in suggestions")}: ${item.title}`}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busyId === item.id}
                      onClick={() => void openEdit(item)}
                      aria-label={`${t("Edit")}: ${item.title}`}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busyId === item.id}
                      onClick={() => void remove(item)}
                      aria-label={`${t("Delete")}: ${item.title}`}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* Test the search */}
        <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
          <Label htmlFor="kb-test" className="text-foreground">
            {t("Test the search")}
          </Label>
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <Input
              id="kb-test"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              maxLength={KB_LIMITS.searchQueryMaxChars}
              placeholder={t("Type a question as a customer would, e.g.: how much is delivery?")}
              className="bg-card text-foreground"
            />
            <Button type="submit" size="sm" className="h-9" disabled={searching || !query.trim()}>
              {searching ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Search className="mr-1.5 size-3.5" />}
              {t("Search")}
            </Button>
          </form>
          <p className="text-xs text-muted-foreground">
            {t("Shows the snippets that would go to the AI with this question. Nothing is sent to the provider here.")}
          </p>
          {hits !== null ? (
            hits.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("Nothing found — the suggestion would rely only on the instructions and the conversation.")}
              </p>
            ) : (
              <ol className="space-y-2">
                {hits.map((hit) => (
                  <li key={hit.chunk_id} className="rounded-md border border-border bg-card px-3 py-2">
                    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span className="truncate font-medium text-foreground" data-no-translate>
                        {hit.title}
                      </span>
                      <span data-no-translate>{hit.rank.toFixed(2)}</span>
                    </div>
                    <p className="mt-1 line-clamp-4 whitespace-pre-line text-sm text-muted-foreground" data-no-translate>
                      {hit.content}
                    </p>
                  </li>
                ))}
              </ol>
            )
          ) : null}
        </div>
      </CardContent>

      <Dialog open={draft !== null} onOpenChange={(open) => (!open && !saving ? setDraft(null) : undefined)}>
        <DialogContent className="border-border bg-popover sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {draft?.id
                ? t("Edit knowledge item")
                : draft?.kind === "faq"
                  ? t("New question")
                  : t("New text")}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {draft?.kind === "faq"
                ? t("Write the question the way customers ask it, and the answer the assistant should use.")
                : t("Short, factual texts work best: one subject per item.")}
            </DialogDescription>
          </DialogHeader>
          {draft ? (
            <div className="space-y-4">
              {draft.kind === "faq" ? (
                <div className="space-y-2">
                  <Label htmlFor="kb-question" className="text-foreground">
                    {t("Question")}
                  </Label>
                  <Input
                    id="kb-question"
                    value={draft.question}
                    maxLength={KB_LIMITS.questionMaxChars}
                    onChange={(e) => setDraft({ ...draft, question: e.target.value })}
                    placeholder={t("E.g.: Do you deliver on Sundays?")}
                    className="bg-card text-foreground"
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="kb-title" className="text-foreground">
                    {t("Title")}
                  </Label>
                  <Input
                    id="kb-title"
                    value={draft.title}
                    maxLength={KB_LIMITS.titleMaxChars}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    placeholder={t("E.g.: Delivery policy")}
                    className="bg-card text-foreground"
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="kb-content" className="text-foreground">
                  {draft.kind === "faq" ? t("Answer") : t("Content")}
                </Label>
                <Textarea
                  id="kb-content"
                  value={draft.content}
                  rows={draft.kind === "faq" ? 5 : 10}
                  maxLength={contentMax}
                  onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                  className="max-h-[50vh] bg-card text-foreground"
                />
                <p className="text-xs text-muted-foreground" data-no-translate>
                  {num.format(draft.content.length)}/{num.format(contentMax)}
                </p>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={() => setDraft(null)}>
              {t("Cancel")}
            </Button>
            <Button disabled={saving || !draftValid} onClick={() => void saveDraft()}>
              {saving ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
              {t("Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
