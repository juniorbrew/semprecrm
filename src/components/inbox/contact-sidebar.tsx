"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useAuth, useEntitlements } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { useLanguage } from "@/hooks/use-language";
import type { Language } from "@/lib/i18n";
import type {
  Contact,
  ContactCustomValue,
  Conversation,
  CustomField,
  Deal,
  ContactNote,
  Pipeline,
  PipelineStage,
  Tag,
} from "@/types";
import {
  Phone,
  Mail,
  Copy,
  Check,
  Tag as TagIcon,
  DollarSign,
  CheckSquare,
  Lock,
  Loader2,
  Ban,
  ShieldCheck,
  CalendarPlus,
  UserRound,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { listConversationsByContact } from "@/lib/conversations/find-by-contact";
import {
  contactHistorySummary,
  csatByConversation,
  listCsatAnswersByContact,
  previousConversationRows,
  type CsatAnswer,
} from "@/lib/conversations/contact-history";
import { useConversationCategories } from "@/hooks/use-conversation-categories";
import { useTeams } from "@/hooks/use-teams";
import { insertConversationEvent } from "@/lib/conversations/events";
import { addContactNote, onContactNotesChanged } from "@/lib/conversations/notes";
import { DealForm } from "@/components/pipelines/deal-form";
import {
  LinkedTaskRows,
  TaskDrawer,
  useLinkedTasks,
} from "@/components/tasks";
import { EventDrawer, LinkedEvents } from "@/components/calendar";
import type { Task } from "@/lib/tasks";
import { NewCustomFieldDialog } from "./new-custom-field-dialog";
import { CustomFieldValue } from "./custom-field-value";
import { ContactPrivacySection } from "@/components/contacts/contact-privacy-section";
import { ContactCompanies } from "@/components/companies/contact-companies";
import { TeamNoteComposer } from "./team-note-composer";
import { ContactAvatar } from "./contact-avatar";
import { ContactMemorySection } from "./contact-memory";
import { toast } from "sonner";
import { PanelSection, SectionAddButton, SectionHeader } from "./panel-section";
import { PanelTags, TAG_PALETTE, type ContactTag } from "./panel-tags";
import { PanelDeals } from "./panel-deals";
import { PanelActivity } from "./panel-activity";
import { PanelSituation } from "./panel-situation";
import { PanelHistory, PanelPreviousConversations } from "./panel-history";

interface ContactSidebarProps {
  contact: Contact | null;
  /** Active thread — label changes are logged as pills against it. */
  conversationId?: string | null;
  /** Active thread's row — drives the "Situação" section (state, owner, SLA). */
  conversation?: Conversation | null;
  /** Jump to another conversation with this contact (previous threads). */
  onOpenConversation?: (conversation: Conversation) => void;
  /** Fired with the refetched row after a privacy action (consent / anonymise). */
  onContactChanged?: (contact: Contact) => void;
}

/**
 * Panel copy is language-keyed (interpolated / gendered forms) and the
 * container is `data-no-translate`, so the DOM translator leaves it be.
 */
const PANEL_COPY: Record<
  Language,
  {
    empty: string;
    copyPhone: string;
    copied: string;
    tags: string;
    noTags: string;
    addTag: string;
    noTagsToPick: string;
    newTagPlaceholder: string;
    createTag: string;
    tagCreateFailed: string;
    companies: string;
    /** Shortcut row under the contact's reach (Deskcomm-style). */
    shortcuts: string;
    scheduleAppointment: string;
    newTask: string;
    newDeal: string;
    viewContact: string;
    readOnly: string;
    serviceTitle: (name: string) => string;
    customFields: string;
    noCustomFields: string;
    emptyValue: string;
    deals: string;
    noDeals: string;
    notes: string;
    noNotes: string;
    notesHint: string;
    tagAdded: (name: string) => string;
    tagRemoved: (name: string) => string;
    /** Tooltip/aria on a tag chip — clicking it removes the tag. */
    removeTag: (name: string) => string;
    tagFailed: string;
    moreNotes: (n: number) => string;
    /** Opt-out badge + admin "Reativar" (migration 030). */
    optedOut: string;
    optedOutHint: (when: string) => string;
    reactivate: string;
    reactivated: string;
    reactivateFailed: string;
  }
> = {
  "pt-BR": {
    empty: "Os detalhes do contato aparecem aqui",
    copyPhone: "Copiar telefone",
    copied: "Copiado",
    tags: "Etiquetas",
    noTags: "Sem etiquetas",
    addTag: "Adicionar etiqueta",
    noTagsToPick: "Nenhuma etiqueta criada ainda. Digite um nome abaixo para criar a primeira.",
    newTagPlaceholder: "Nova etiqueta…",
    createTag: "Criar",
    tagCreateFailed: "Não foi possível criar a etiqueta",
    companies: "Empresas",
    shortcuts: "Atalhos do contato",
    scheduleAppointment: "Marcar compromisso",
    newTask: "Nova tarefa",
    newDeal: "Novo negócio",
    viewContact: "Ver contato",
    readOnly: "Somente leitura — seu perfil não pode criar compromissos, negócios nem tarefas",
    serviceTitle: (name) => `Atendimento: ${name}`,
    customFields: "Campos personalizados",
    noCustomFields: "Nenhum campo personalizado definido",
    emptyValue: "—",
    deals: "Negócios vinculados",
    noDeals: "Nenhum negócio vinculado",
    notes: "Notas internas",
    noNotes: "Nenhuma nota ainda",
    notesHint: "Use a aba Nota interna na caixa de resposta",
    tagAdded: (name) => `Etiqueta ${name} adicionada`,
    tagRemoved: (name) => `Etiqueta ${name} removida`,
    removeTag: (name) => `Remover etiqueta ${name}`,
    tagFailed: "Não foi possível atualizar a etiqueta",
    moreNotes: (n) => `+${n} nota${n === 1 ? "" : "s"} na conversa`,
    optedOut: "Descadastrado",
    optedOutHint: (when) =>
      `Pediu para não receber mensagens em ${when}. Automações e disparos não enviam para este contato.`,
    reactivate: "Reativar",
    reactivated: "Contato reativado",
    reactivateFailed: "Não foi possível reativar o contato",
  },
  "en-US": {
    empty: "Contact details will appear here",
    copyPhone: "Copy phone",
    copied: "Copied",
    tags: "Labels",
    noTags: "No labels",
    addTag: "Add label",
    noTagsToPick: "No labels yet. Type a name below to create the first one.",
    newTagPlaceholder: "New label…",
    createTag: "Create",
    tagCreateFailed: "Could not create the label",
    companies: "Companies",
    shortcuts: "Contact shortcuts",
    scheduleAppointment: "Book appointment",
    newTask: "New task",
    newDeal: "New deal",
    viewContact: "View contact",
    readOnly: "Read-only — your role can't create appointments, deals or tasks",
    serviceTitle: (name) => `Service: ${name}`,
    customFields: "Custom fields",
    noCustomFields: "No custom fields defined",
    emptyValue: "—",
    deals: "Linked deals",
    noDeals: "No linked deals",
    notes: "Internal notes",
    noNotes: "No notes yet",
    notesHint: "Use the Private note tab in the composer",
    tagAdded: (name) => `Label ${name} added`,
    tagRemoved: (name) => `Label ${name} removed`,
    removeTag: (name) => `Remove label ${name}`,
    tagFailed: "Could not update the label",
    moreNotes: (n) => `+${n} note${n === 1 ? "" : "s"} in the thread`,
    optedOut: "Opted out",
    optedOutHint: (when) =>
      `Asked to stop receiving messages on ${when}. Automations and broadcasts skip this contact.`,
    reactivate: "Reactivate",
    reactivated: "Contact reactivated",
    reactivateFailed: "Could not reactivate the contact",
  },
};

/** Notes shown in the panel; the full list lives in the thread. */
const MAX_PANEL_NOTES = 3;

function formatDateTime(iso: string, language: Language): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(language, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Text-first action in the contact shortcut row (no tile, no border). */
const ACTION_CLS =
  "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50";

/** One action of the contact shortcut row. */
function ShortcutButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  busy,
  title,
  hidden,
}: {
  icon: typeof TagIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  title: string;
  /** Module not on the plan — the tile is left out. */
  hidden?: boolean;
}) {
  if (hidden) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={ACTION_CLS}
    >
      {busy ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
      ) : (
        <Icon className="size-3.5" aria-hidden />
      )}
      {label}
    </button>
  );
}

export function ContactSidebar({
  contact,
  conversationId = null,
  conversation = null,
  onOpenConversation,
  onContactChanged,
}: ContactSidebarProps) {
  const { user, profile, accountId } = useAuth();
  const { language, t } = useLanguage();
  const copy = PANEL_COPY[language] ?? PANEL_COPY["pt-BR"];
  // Admin+ can define fields (custom_fields RLS); agent+ can write values,
  // deals and notes. Viewers see everything read-only.
  const canDefineFields = useCan("edit-settings");
  const canWrite = useCan("send-messages");
  // Reverting an opt-out is an admin+ action (spec §5).
  const canReactivate = useCan("edit-settings");
  const { ready: entitlementsReady, modules } = useEntitlements();
  const pipelinesEnabled = !entitlementsReady || modules.pipelines;
  const tasksEnabled = !entitlementsReady || modules.tasks;
  const calendarEnabled = !entitlementsReady || modules.calendar;
  const aiEnabled = entitlementsReady && modules.ai;
  const [copied, setCopied] = useState(false);
  // Opt-out state mirrors `contact.opted_out_at` but is kept locally so
  // "Reativar" reflects at once, before the parent refetches the contact.
  const [optedOutAt, setOptedOutAt] = useState<string | null>(contact?.opted_out_at ?? null);
  const [reactivating, setReactivating] = useState(false);
  useEffect(() => {
    setOptedOutAt(contact?.opted_out_at ?? null);
  }, [contact?.id, contact?.opted_out_at]);

  // LGPD (migration 035): after a consent change or anonymisation the
  // row is re-read so the badge / blocked composer reflect at once.
  const handlePrivacyChanged = useCallback(async () => {
    if (!contact?.id) return;
    const supabase = createClient();
    const { data } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", contact.id)
      .maybeSingle();
    if (data) onContactChanged?.(data as Contact);
  }, [contact?.id, onContactChanged]);

  const handleReactivate = useCallback(async () => {
    if (!contact?.id || !accountId || !user?.id || reactivating) return;
    setReactivating(true);
    const supabase = createClient();
    try {
      const { error } = await supabase
        .from("contacts")
        .update({ opted_out_at: null, updated_at: new Date().toISOString() })
        .eq("id", contact.id);
      if (error) throw error;
      setOptedOutAt(null);
      if (conversationId) {
        await insertConversationEvent(supabase, {
          account_id: accountId,
          conversation_id: conversationId,
          actor_user_id: user.id,
          event_type: "contact_opted_in",
          payload: { actor_name: profile?.full_name ?? undefined },
        });
      }
      toast.success(copy.reactivated);
    } catch (err) {
      console.error("Failed to reactivate contact:", err);
      toast.error(copy.reactivateFailed);
    } finally {
      setReactivating(false);
    }
  }, [contact?.id, accountId, user?.id, reactivating, conversationId, profile?.full_name, copy]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [contactTags, setContactTags] = useState<ContactTag[]>([]);
  const [tagUsage, setTagUsage] = useState<Record<string, number>>({});
  // Which contact the first fetch has finished for (skeletons until then).
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  // Bumped after panel actions that write to the activity feed.
  const [activityVersion, setActivityVersion] = useState(0);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [previous, setPrevious] = useState<Conversation[]>([]);
  const [csatAnswers, setCsatAnswers] = useState<CsatAnswer[]>([]);
  const [tagBusy, setTagBusy] = useState<string | null>(null);
  const [creatingTag, setCreatingTag] = useState(false);
  const [newFieldOpen, setNewFieldOpen] = useState(false);
  const [noteComposerOpen, setNoteComposerOpen] = useState(false);
  // "Novo negócio": the first pipeline + its stages, loaded on demand when
  // the + is clicked so the panel's initial fetch stays lean.
  const [dealTarget, setDealTarget] = useState<{
    pipeline: Pipeline;
    stages: PipelineStage[];
  } | null>(null);
  const [dealFormOpen, setDealFormOpen] = useState(false);
  const [dealTargetLoading, setDealTargetLoading] = useState(false);
  // Tasks: open ones for this contact; opening one shows the task drawer.
  const [taskDrawerTask, setTaskDrawerTask] = useState<Task | null>(null);
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false);
  // "Marcar compromisso" shortcut: the agenda's create sheet prefilled
  // with this contact + thread; bumping the key refreshes LinkedEvents.
  const [eventDrawerOpen, setEventDrawerOpen] = useState(false);
  const [eventsVersion, setEventsVersion] = useState(0);
  // "Nova tarefa" shortcut: the full task drawer, contact locked.
  const [newTaskOpen, setNewTaskOpen] = useState(false);

  const contactId = contact?.id ?? null;
  const linkedTasks = useLinkedTasks({ contactId, enabled: tasksEnabled });

  // "Situação" / "Conversas anteriores": names for the ids on the rows.
  const { byId: categoryById } = useConversationCategories();
  const { byId: teamById } = useTeams();
  const ownerId = conversation?.assigned_agent_id ?? null;
  const [owner, setOwner] = useState<{ id: string; name: string | null } | null>(null);
  useEffect(() => {
    if (!ownerId || ownerId === user?.id) return;
    let cancelled = false;
    void createClient()
      .from("profiles")
      .select("full_name")
      .eq("user_id", ownerId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setOwner({ id: ownerId, name: (data?.full_name as string | undefined) ?? null });
      });
    return () => {
      cancelled = true;
    };
  }, [ownerId, user?.id]);
  const csatMap = useMemo(() => csatByConversation(csatAnswers), [csatAnswers]);
  const previousRows = useMemo(
    () => previousConversationRows(previous, conversationId, csatMap, (id) => categoryById.get(id)?.name),
    [previous, conversationId, csatMap, categoryById],
  );
  const historySummary = useMemo(
    () => contactHistorySummary(previous, csatMap, contact?.created_at),
    [previous, csatMap, contact?.created_at],
  );

  const fetchContactData = useCallback(async () => {
    if (!contactId) return;
    const supabase = createClient();

    const [dealsRes, notesRes, tagsRes, allTagsRes, fieldsRes, valuesRes, convs, usageRes, csat] =
      await Promise.all([
        supabase
          .from("deals")
          .select("*, stage:pipeline_stages(*)")
          .eq("contact_id", contactId)
          .order("created_at", { ascending: false }),
        supabase
          .from("contact_notes")
          .select("*")
          .eq("contact_id", contactId)
          .order("created_at", { ascending: false }),
        supabase
          .from("contact_tags")
          .select("id, tag_id, tags(*)")
          .eq("contact_id", contactId),
        supabase.from("tags").select("*").order("name"),
        supabase.from("custom_fields").select("*").order("field_name"),
        supabase
          .from("contact_custom_values")
          .select("*")
          .eq("contact_id", contactId),
        listConversationsByContact(supabase, contactId),
        supabase.rpc("account_tag_usage"),
        listCsatAnswersByContact(supabase, contactId),
      ]);

    if (dealsRes.data) setDeals(dealsRes.data as Deal[]);
    if (notesRes.data) setNotes(notesRes.data as ContactNote[]);
    if (tagsRes.data) {
      const mapped = tagsRes.data
        .filter((ct: Record<string, unknown>) => ct.tags)
        .map((ct: Record<string, unknown>) => ({
          ...(ct.tags as Tag),
          contact_tag_id: ct.id as string,
        }));
      setContactTags(mapped);
    }
    if (allTagsRes.data) setAllTags(allTagsRes.data as Tag[]);
    if (fieldsRes.data) setCustomFields(fieldsRes.data as CustomField[]);
    if (valuesRes.data) {
      const map: Record<string, string> = {};
      for (const v of valuesRes.data as ContactCustomValue[]) {
        map[v.custom_field_id] = v.value ?? "";
      }
      setCustomValues(map);
    }
    if (usageRes.data) {
      const usage: Record<string, number> = {};
      for (const row of usageRes.data as { tag_id: string; uses: number | string }[]) {
        usage[row.tag_id] = Number(row.uses);
      }
      setTagUsage(usage);
    }
    setPrevious(convs);
    setCsatAnswers(csat);
    setLoadedFor(contactId);
  }, [contactId]);

  // Load on contact change; all setState calls happen inside the async
  // Supabase callbacks, not synchronously in the effect body.
  useEffect(() => {
    void fetchContactData();
  }, [fetchContactData]);

  // Notes added from the composer's "Nota interna" tab show up here too.
  useEffect(() => {
    if (!contactId) return;
    return onContactNotesChanged(contactId, () => {
      const supabase = createClient();
      supabase
        .from("contact_notes")
        .select("*")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false })
        .then(({ data }) => {
          if (data) setNotes(data as ContactNote[]);
        });
    });
  }, [contactId]);

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // Dep is the whole `contact` object (not `contact?.phone`) so the
    // React Compiler's inference agrees with the manual dep list.
  }, [contact]);

  // Toggle a label on the contact and log it to the shared event log so
  // the active thread (this tab and every teammate's) shows the pill
  // "Etiqueta VIP adicionada por Ana".
  const toggleTag = useCallback(
    async (tag: Tag) => {
      if (!contactId || tagBusy) return;
      setTagBusy(tag.id);
      const supabase = createClient();
      const existing = contactTags.find((t) => t.id === tag.id);
      const actor = profile?.full_name || user?.email || undefined;
      const logLabelEvent = (event_type: "label_added" | "label_removed") => {
        if (!conversationId || !accountId) return;
        void insertConversationEvent(supabase, {
          account_id: accountId,
          conversation_id: conversationId,
          actor_user_id: user?.id ?? null,
          event_type,
          payload: { actor_name: actor, tag_id: tag.id, tag_name: tag.name },
        }).then(() => setActivityVersion((v) => v + 1));
      };
      try {
        if (existing) {
          const { error } = await supabase
            .from("contact_tags")
            .delete()
            .eq("id", existing.contact_tag_id);
          if (error) throw error;
          setContactTags((prev) => prev.filter((t) => t.id !== tag.id));
          logLabelEvent("label_removed");
          toast.success(copy.tagRemoved(tag.name));
        } else {
          const { data, error } = await supabase
            .from("contact_tags")
            .insert({ contact_id: contactId, tag_id: tag.id })
            .select("id")
            .single();
          if (error || !data) throw error ?? new Error("insert failed");
          setContactTags((prev) => [
            ...prev,
            { ...tag, contact_tag_id: data.id as string },
          ]);
          logLabelEvent("label_added");
          toast.success(copy.tagAdded(tag.name));
        }
      } catch (err) {
        console.error("Failed to toggle tag:", err);
        toast.error(copy.tagFailed);
      } finally {
        setTagBusy(null);
      }
    },
    [
      contactId,
      tagBusy,
      contactTags,
      conversationId,
      accountId,
      profile?.full_name,
      user?.email,
      user?.id,
      copy,
    ],
  );

  /** Create a tag inline (same palette as Settings › Tags) and attach it. */
  const createAndAttachTag = useCallback(async (rawName: string, colorChoice?: string) => {
    const name = rawName.trim();
    if (!name || creatingTag || !accountId || !user?.id) return;
    const duplicate = allTags.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (duplicate) {
      if (!contactTags.some((t) => t.id === duplicate.id)) void toggleTag(duplicate);
      return;
    }
    setCreatingTag(true);
    const supabase = createClient();
    const color = colorChoice ?? TAG_PALETTE[allTags.length % TAG_PALETTE.length];
    try {
      const { data, error } = await supabase
        .from("tags")
        .insert({ user_id: user.id, account_id: accountId, name, color })
        .select("*")
        .single();
      if (error || !data) throw error ?? new Error("insert failed");
      const tag = data as Tag;
      setAllTags((prev) => [...prev, tag].sort((a, b) => a.name.localeCompare(b.name)));
      await toggleTag(tag);
    } catch (err) {
      console.error("Failed to create tag:", err);
      toast.error(copy.tagCreateFailed);
    } finally {
      setCreatingTag(false);
    }
  }, [creatingTag, accountId, user?.id, allTags, contactTags, toggleTag, copy.tagCreateFailed]);

  const refreshDeals = useCallback(async () => {
    if (!contactId) return;
    const { data } = await createClient()
      .from("deals")
      .select("*, stage:pipeline_stages(*)")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false });
    if (data) setDeals(data as Deal[]);
  }, [contactId]);

  const patchDeal = useCallback((dealId: string, patch: Partial<Deal>) => {
    setDeals((prev) => prev.map((d) => (d.id === dealId ? { ...d, ...patch } : d)));
  }, []);

  // Resolve the first pipeline (by creation) and its stages, then open the
  // shared deal sheet prefilled with this contact and the first stage.
  const openNewDeal = useCallback(async () => {
    if (dealTargetLoading) return;
    if (dealTarget) {
      setDealFormOpen(true);
      return;
    }
    setDealTargetLoading(true);
    const supabase = createClient();
    try {
      const { data: pipelines, error } = await supabase
        .from("pipelines")
        .select("*")
        .order("created_at")
        .limit(1);
      if (error) throw error;
      const pipeline = (pipelines as Pipeline[] | null)?.[0];
      if (!pipeline) {
        toast.error(t("Create a pipeline first in Pipelines."));
        return;
      }
      const { data: stages, error: stagesError } = await supabase
        .from("pipeline_stages")
        .select("*")
        .eq("pipeline_id", pipeline.id)
        .order("position");
      if (stagesError) throw stagesError;
      setDealTarget({ pipeline, stages: (stages as PipelineStage[] | null) ?? [] });
      setDealFormOpen(true);
    } catch (err) {
      console.error("Failed to load pipelines:", err);
      toast.error(t("Could not load pipelines"));
    } finally {
      setDealTargetLoading(false);
    }
  }, [dealTarget, dealTargetLoading, t]);

  // Same write path as the composer's "Nota interna" tab (insert +
  // cross-component notify + `note_added` audit event on this thread).
  const submitTeamNote = useCallback(
    async (text: string) => {
      if (!contactId || !accountId || !user?.id) {
        toast.error(t("Could not save the note"));
        throw new Error("missing contact/account/user");
      }
      try {
        const note = await addContactNote(createClient(), {
          contactId,
          accountId,
          userId: user.id,
          text,
          conversationId,
          actorName: profile?.full_name || user.email || undefined,
        });
        setNotes((prev) => [note, ...prev]);
        setNoteComposerOpen(false);
        toast.success(t("Private note added"));
      } catch (err) {
        console.error("Failed to add note:", err);
        toast.error(t("Could not save the note"));
        throw err;
      }
    },
    [contactId, accountId, user, conversationId, profile?.full_name, t],
  );

  const handleFieldCreated = useCallback((field: CustomField) => {
    setCustomFields((prev) =>
      [...prev.filter((f) => f.id !== field.id), field].sort((a, b) =>
        a.field_name.localeCompare(b.field_name),
      ),
    );
  }, []);

  const handleValueSaved = useCallback((fieldId: string, value: string) => {
    setCustomValues((prev) => ({ ...prev, [fieldId]: value }));
  }, []);

  if (!contact) {
    return (
      <div
        data-no-translate
        className="flex h-full w-70 items-center justify-center border-l border-border bg-card"
      >
        <p className="px-4 text-center text-sm text-muted-foreground">{copy.empty}</p>
      </div>
    );
  }

  const panelLoaded = loadedFor === contact.id;
  const activityLabel = language === "pt-BR" ? "Atividade" : "Activity";
  const displayName = contact.name || contact.phone;
  const panelNotes = notes.slice(0, MAX_PANEL_NOTES);
  const hiddenNotes = notes.length - panelNotes.length;

  return (
    <div
      data-no-translate
      className="flex h-full min-h-0 w-70 flex-col overflow-hidden border-l border-border bg-card"
    >
      {/* `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it the ScrollArea grew to the
          panel's full content height (~795 px inside a 711 px column),
          overflowed the column and was clipped by main's overflow-hidden
          with scrollTop pinned at 0 — the Team notes section was cut off
          and unreachable at 1440x800. With it the viewport is the column
          height and the panel scrolls on its own. */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-4">
          {/* Identity — avatar beside name + company. No presence dot:
              contacts carry no availability data (only agents do). */}
          <div className="flex items-center gap-3">
            <ContactAvatar
              key={contact.id}
              src={contact.avatar_url}
              name={displayName}
              className="h-11 w-11 shrink-0 text-sm font-semibold"
            />
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-sm font-semibold text-foreground">{displayName}</h3>
              {contact.anonymized_at && (
                <span
                  className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground"
                  title={t("Personal data removed (LGPD)")}
                >
                  <ShieldCheck className="h-3 w-3" aria-hidden />
                  {t("Anonymized")}
                </span>
              )}
              {optedOutAt && !contact.anonymized_at && (
                <div
                  className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5"
                  title={copy.optedOutHint(new Date(optedOutAt).toLocaleDateString(language))}
                >
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-red-600 dark:text-red-400">
                    <Ban className="h-3 w-3" aria-hidden />
                    {copy.optedOut}
                  </span>
                  {canReactivate && (
                    <button
                      type="button"
                      onClick={handleReactivate}
                      disabled={reactivating}
                      className="text-[11px] font-medium text-primary underline-offset-2 hover:underline disabled:opacity-60"
                    >
                      {reactivating ? <Loader2 className="inline h-3 w-3 animate-spin" /> : copy.reactivate}
                    </button>
                  )}
                </div>
              )}
              {contact.company && (
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{contact.company}</p>
              )}
            </div>
          </div>

          {/* Reach */}
          <div className="-mx-2 mt-3 space-y-0.5">
            <button
              type="button"
              onClick={handleCopyPhone}
              title={copied ? copy.copied : copy.copyPhone}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              <Phone className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate text-left tabular-nums text-foreground">
                {contact.phone}
              </span>
              {copied ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <Copy className="h-3 w-3 text-muted-foreground" />
              )}
            </button>

            {contact.email && (
              <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground">
                <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 break-all" title={contact.email}>
                  {contact.email}
                </span>
              </div>
            )}
          </div>

          {/* Shortcuts — book an appointment (agenda sheet), open a deal
              (deal sheet; its company defaults to the contact's primary
              one) and jump to the contact page. Viewers see the first two
              disabled. */}
          <div
            role="group"
            aria-label={copy.shortcuts}
            className="-mx-2 mt-3 flex flex-wrap gap-y-0.5"
          >
            <ShortcutButton
              icon={CalendarPlus}
              label={copy.scheduleAppointment}
              onClick={() => setEventDrawerOpen(true)}
              disabled={!canWrite || !calendarEnabled}
              title={!canWrite ? copy.readOnly : copy.scheduleAppointment}
              hidden={!calendarEnabled}
            />
            <ShortcutButton
              icon={CheckSquare}
              label={copy.newTask}
              onClick={() => setNewTaskOpen(true)}
              disabled={!canWrite}
              title={!canWrite ? copy.readOnly : copy.newTask}
              hidden={!tasksEnabled}
            />
            <ShortcutButton
              icon={DollarSign}
              label={copy.newDeal}
              onClick={() => void openNewDeal()}
              disabled={!canWrite || !pipelinesEnabled || dealTargetLoading}
              busy={dealTargetLoading}
              title={!canWrite ? copy.readOnly : copy.newDeal}
              hidden={!pipelinesEnabled}
            />
            <Link
              href={`/contacts?contact=${encodeURIComponent(contact.id)}`}
              title={copy.viewContact}
              className={ACTION_CLS}
            >
              <UserRound className="size-3.5" aria-hidden />
              {copy.viewContact}
            </Link>
          </div>
          {tasksEnabled && canWrite && (
            <TaskDrawer
              open={newTaskOpen}
              onOpenChange={setNewTaskOpen}
              task={null}
              lockContact
              defaults={{
                contact_id: contact.id,
                conversation_id: conversationId ?? undefined,
                assignee_user_id: user?.id,
              }}
              statuses={linkedTasks.statuses}
              onCreated={(task) => {
                linkedTasks.add(task);
                void linkedTasks.refresh();
              }}
            />
          )}
          {calendarEnabled && canWrite && (
            <EventDrawer
              open={eventDrawerOpen}
              onOpenChange={setEventDrawerOpen}
              event={null}
              defaults={{
                contact_id: contact.id,
                conversation_id: conversationId ?? undefined,
                title: copy.serviceTitle(displayName),
              }}
              onCreated={() => setEventsVersion((v) => v + 1)}
            />
          )}

          {/* Situação of the open conversation (state, priority, owner,
              team, SLA) — from the row the inbox already holds. */}
          {conversation && conversation.contact_id === contact.id && (
            <>
              <div className="-mx-4 my-3.5 border-t border-border" />
              <PanelSituation
                conversation={conversation}
                currentUserId={user?.id}
                ownerName={owner && owner.id === conversation.assigned_agent_id ? owner.name : null}
                teamName={conversation.team_id ? (teamById.get(conversation.team_id)?.name ?? null) : null}
              />
            </>
          )}

          {tasksEnabled && (
            <>
              <div className="-mx-4 my-3.5 border-t border-border" />

              {/* Tasks: open tasks linked to this contact; the checkbox
                  completes (default done status). Creating a task is the
                  "Nova tarefa" shortcut at the top of the panel. */}
              <PanelSection id="tasks">
                <div>
                  <SectionHeader
                    label={t("Tasks")}
                    count={linkedTasks.tasks.length}
                  />
                  <div className="mt-2 space-y-2 px-1">
                    <LinkedTaskRows
                      tasks={linkedTasks.tasks}
                      readOnly={!canWrite}
                      emptyLabel={
                        linkedTasks.loading ? t("Loading...") : t("No open tasks")
                      }
                      onComplete={(task) => void linkedTasks.complete(task)}
                      onOpen={(task) => {
                        setTaskDrawerTask(task);
                        setTaskDrawerOpen(true);
                      }}
                    />
                  </div>
                </div>
              </PanelSection>
              <TaskDrawer
                open={taskDrawerOpen}
                onOpenChange={setTaskDrawerOpen}
                task={taskDrawerTask}
                statuses={linkedTasks.statuses}
                onUpdated={linkedTasks.patch}
                onDeleted={linkedTasks.remove}
              />
            </>
          )}


          <div className="-mx-4 my-3.5 border-t border-border" />

          {/* The contact's other conversations (latest 5): date, subject
              or category, state and the CSAT score (migration 074). */}
          <PanelSection id="previous">
            <PanelPreviousConversations
              rows={previousRows}
              loaded={panelLoaded}
              onOpen={
                onOpenConversation
                  ? (conv) => onOpenConversation({ ...conv, contact: conv.contact ?? contact })
                  : undefined
              }
            />
          </PanelSection>

          <div className="-mx-4 my-3.5 border-t border-border" />

          <PanelSection id="history">
            <PanelHistory summary={historySummary} loaded={panelLoaded} />
          </PanelSection>

          <div className="-mx-4 my-3.5 border-t border-border" />

          {/* Labels: click a chip to remove, one-click "most used"
              suggestions, quick create with colour. Every section below
              is collapsible and remembers its open/closed state. */}
          <PanelSection id="tags">
            <PanelTags
              contactTags={contactTags}
              allTags={allTags}
              usage={tagUsage}
              loaded={panelLoaded}
              canWrite={canWrite}
              canCreate={canDefineFields}
              busyId={tagBusy}
              creating={creatingTag}
              onToggle={(tag) => void toggleTag(tag)}
              onCreate={(name, color) => void createAndAttachTag(name, color)}
            />
          </PanelSection>

          <div className="-mx-4 my-3.5 border-t border-border" />

          {/* Custom fields: every account definition, this contact's
              value editable inline; "+" defines a new field (admin+). */}
          <PanelSection id="fields" defaultOpen={false}>
            <div>
              <SectionHeader
                label={copy.customFields}
                count={customFields.length}
                action={
                  canDefineFields ? (
                    <SectionAddButton
                      label={t("Add custom field")}
                      onClick={() => setNewFieldOpen(true)}
                    />
                  ) : undefined
                }
              />
              <div className="mt-2 px-1">
                {!panelLoaded ? (
                  <div className="h-8 animate-pulse rounded-lg bg-muted/60" />
                ) : customFields.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{copy.noCustomFields}</p>
                ) : (
                  <dl className="divide-y divide-border/60">
                    {customFields.map((field) => (
                      <CustomFieldValue
                        key={field.id}
                        contactId={contact.id}
                        field={field}
                        value={customValues[field.id] ?? ""}
                        onSaved={handleValueSaved}
                        emptyLabel={copy.emptyValue}
                        disabled={!canWrite}
                      />
                    ))}
                  </dl>
                )}
              </div>
            </div>
          </PanelSection>
          <NewCustomFieldDialog
            open={newFieldOpen}
            onOpenChange={setNewFieldOpen}
            existing={customFields}
            onCreated={handleFieldCreated}
          />

          <div className="-mx-4 my-3.5 border-t border-border" />

          {/* Companies (migration 054): primary first, each linking to
              /companies?company=id; agent+ links / unlinks / marks the
              primary through the shared data layer. */}
          <PanelSection id="companies">
            <ContactCompanies
              key={contact.id}
              contactId={contact.id}
              readOnly={!canWrite}
              compact
              header={({ count, togglePicker, readOnly }) => (
                <SectionHeader
                  label={copy.companies}
                  count={count}
                  action={
                    readOnly ? undefined : (
                      <SectionAddButton label={t("Link company")} onClick={togglePicker} />
                    )
                  }
                />
              )}
            />
          </PanelSection>

          <div className="-mx-4 my-3.5 border-t border-border" />

          {/* Linked deals: stage select + expandable deal fields; "+"
              opens the shared deal sheet prefilled with this contact;
              hidden when the plan has no Pipelines. */}
          <PanelSection id="deals">
            <PanelDeals
              deals={deals}
              onPatch={patchDeal}
              onMoved={() => setActivityVersion((v) => v + 1)}
              loaded={panelLoaded}
              canWrite={canWrite}
              conversationId={conversationId}
              addAction={
                pipelinesEnabled && canWrite ? (
                  <SectionAddButton
                    label={t("Add Deal")}
                    onClick={() => void openNewDeal()}
                    disabled={dealTargetLoading}
                  />
                ) : undefined
              }
            />
          </PanelSection>
          {dealTarget && (
            <DealForm
              open={dealFormOpen}
              onOpenChange={setDealFormOpen}
              pipelineId={dealTarget.pipeline.id}
              stages={dealTarget.stages}
              defaultStageId={dealTarget.stages[0]?.id}
              defaultContactId={contact.id}
              onSaved={() => void refreshDeals()}
            />
          )}

          {calendarEnabled && (
            <>
              <div className="-mx-4 my-3.5 border-t border-border" />

              {/* Agenda: the contact's next appointments; "+" reveals the
                  inline title + when creator linked to the contact and thread. */}
              <PanelSection id="agenda" lazyHeader={<SectionHeader label={t("Calendar")} />}>
                <LinkedEvents
                  key={`${contact.id}:${eventsVersion}`}
                  contactId={contact.id}
                  defaults={{ conversation_id: conversationId ?? undefined }}
                  readOnly={!canWrite}
                  headerClassName="px-1"
                  bodyClassName="px-1"
                />
              </PanelSection>
            </>
          )}

          <div className="-mx-4 my-3.5 border-t border-border" />

          {/* Activity: merged feed (contact_activity RPC, migration 070). */}
          <PanelSection id="activity" lazyHeader={<SectionHeader label={activityLabel} />}>
            <PanelActivity contactId={contact.id} refreshKey={activityVersion} />
          </PanelSection>

          {/* Contact memory (AI, migration 064): facts used in suggestions. */}
          {aiEnabled && (
            <>
              <div className="-mx-4 my-3.5 border-t border-border" />
              <PanelSection id="memory" lazyHeader={<SectionHeader label={t("Contact memory")} />}>
                <ContactMemorySection
                  contactId={contact.id}
                  conversationId={conversationId}
                  anonymized={!!contact.anonymized_at}
                  renderHeader={(action, count) => (
                    <SectionHeader label={t("Contact memory")} count={count} action={action} />
                  )}
                  renderAddButton={(label, onClick) => <SectionAddButton label={label} onClick={onClick} />}
                />
              </PanelSection>
            </>
          )}

          <div className="-mx-4 my-3.5 border-t border-border" />

          {/* Team notes: the latest few; the full history sits in the
              thread as amber bubbles. "+" reveals an inline note box that
              writes through the same path as the composer note tab. */}
          <PanelSection id="notes">
            <div>
              <SectionHeader
                label={copy.notes}
                count={notes.length}
                action={
                  canWrite ? (
                    <SectionAddButton
                      label={t("Add team note")}
                      onClick={() => setNoteComposerOpen((open) => !open)}
                    />
                  ) : undefined
                }
              />
              <div className="mt-2 space-y-2 px-1">
                {noteComposerOpen && (
                  <TeamNoteComposer
                    onSubmit={submitTeamNote}
                    onCancel={() => setNoteComposerOpen(false)}
                  />
                )}
                {panelNotes.length === 0 ? (
                  <div>
                    <p className="text-xs text-muted-foreground">{copy.noNotes}</p>
                    <p className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-muted-foreground/80">
                      <Lock className="h-3 w-3" />
                      {copy.notesHint}
                    </p>
                  </div>
                ) : (
                  <>
                    {panelNotes.map((note) => (
                      <div
                        key={note.id}
                        className="border-l-2 border-amber-500/50 pl-2.5"
                      >
                        <p className="line-clamp-3 whitespace-pre-wrap text-xs text-foreground">
                          {note.note_text}
                        </p>
                        <p className="mt-1 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                          <Lock className="h-2.5 w-2.5" />
                          {formatDateTime(note.created_at, language)}
                        </p>
                      </div>
                    ))}
                    {hiddenNotes > 0 && (
                      <p className="text-[10px] text-muted-foreground">
                        {copy.moreNotes(hiddenNotes)}
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          </PanelSection>

          <div className="-mx-4 my-3.5 border-t border-border" />

          {/* Privacy (LGPD, migration 035): consent, export, anonymise. */}
          <PanelSection id="privacy" defaultOpen={false} lazyHeader={<SectionHeader label={t("Privacy")} />}>
            <div>
              <SectionHeader label={t("Privacy")} />
              <ContactPrivacySection
                compact
                className="mt-2"
                contact={contact}
                onChanged={() => void handlePrivacyChanged()}
              />
            </div>
          </PanelSection>
        </div>
      </ScrollArea>
    </div>
  );
}
