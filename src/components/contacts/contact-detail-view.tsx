'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { createClient } from '@/lib/supabase/client';
import { useAuth, useEntitlements } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { LinkedEvents } from '@/components/calendar';
import { useLanguage } from '@/hooks/use-language';
import { formatCurrency } from '@/lib/currency';
import {
  inboxConversationHref,
  listConversationsByContact,
} from '@/lib/conversations/find-by-contact';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type {
  Contact,
  Tag,
  ContactNote,
  CustomField,
  Deal,
  Conversation,
  ConversationStatus,
} from '@/types';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Phone,
  Mail,
  Building2,
  Copy,
  Check,
  Loader2,
  Plus,
  Trash2,
  Save,
  DollarSign,
  MessageCircle,
  MessageSquare,
  Pencil,
  ArrowUpRight,
  X,
  ShieldCheck,
} from 'lucide-react';
import { ContactPrivacySection } from './contact-privacy-section';

interface ContactDetailViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string | null;
  onUpdated: () => void;
  /** Optional destructive action. When provided, a delete button is shown
   *  in the header action row; the parent owns the confirmation flow. */
  onDelete?: (contact: Contact) => void;
}

type PanelMode = 'view' | 'edit';

const STATUS_DOT: Record<ConversationStatus, string> = {
  open: 'bg-primary',
  pending: 'bg-amber-500',
  closed: 'bg-muted-foreground',
};

const STATUS_LABEL_KEY: Record<ConversationStatus, string> = {
  open: 'Open',
  pending: 'Pending',
  closed: 'Closed',
};

export function ContactDetailView({
  open,
  onOpenChange,
  contactId,
  onUpdated,
  onDelete,
}: ContactDetailViewProps) {
  const supabase = createClient();
  const router = useRouter();
  const { t, language } = useLanguage();
  const { accountId, defaultCurrency, user } = useAuth();
  const canSend = useCan('send-messages');
  // "Agenda" tab — hidden when the plan has no Calendar module.
  const { ready: entitlementsReady, modules } = useEntitlements();
  const calendarEnabled = !entitlementsReady || modules.calendar;

  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(false);
  const [copiedPhone, setCopiedPhone] = useState(false);
  const [mode, setMode] = useState<PanelMode>('view');

  // Conversations (default tab + header primary action)
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [openingConversation, setOpeningConversation] = useState(false);

  // Edit mode
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editCompany, setEditCompany] = useState('');
  const [savingDetails, setSavingDetails] = useState(false);

  // Tags tab
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [contactTagIds, setContactTagIds] = useState<string[]>([]);
  const [savingTags, setSavingTags] = useState(false);

  // Notes tab
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [newNote, setNewNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [loadingNotes, setLoadingNotes] = useState(false);

  // Custom fields tab
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [savingCustom, setSavingCustom] = useState(false);
  const [loadingCustom, setLoadingCustom] = useState(false);

  // Deals tab
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loadingDeals, setLoadingDeals] = useState(false);

  const fetchContact = useCallback(async () => {
    if (!contactId) return;
    setLoading(true);

    const { data } = await supabase
      .from('contacts')
      .select('*')
      .eq('id', contactId)
      .single();

    if (data) {
      setContact(data);
      setEditName(data.name ?? '');
      setEditPhone(data.phone);
      setEditEmail(data.email ?? '');
      setEditCompany(data.company ?? '');
    }
    setLoading(false);
  }, [contactId, supabase]);

  const fetchConversations = useCallback(async () => {
    if (!contactId) return;
    setLoadingConversations(true);
    // Shared with the deal drawer (Pipelines) so both screens agree on
    // which thread is "the contact's conversation": newest activity first.
    setConversations(await listConversationsByContact(supabase, contactId));
    setLoadingConversations(false);
  }, [contactId, supabase]);

  const fetchTags = useCallback(async () => {
    if (!contactId) return;

    const [tagsRes, contactTagsRes] = await Promise.all([
      supabase.from('tags').select('*').order('name'),
      supabase.from('contact_tags').select('tag_id').eq('contact_id', contactId),
    ]);

    if (tagsRes.data) setAllTags(tagsRes.data);
    if (contactTagsRes.data) {
      setContactTagIds(contactTagsRes.data.map((ct) => ct.tag_id));
    }
  }, [contactId, supabase]);

  const fetchNotes = useCallback(async () => {
    if (!contactId) return;
    setLoadingNotes(true);

    const { data } = await supabase
      .from('contact_notes')
      .select('*')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false });

    if (data) setNotes(data);
    setLoadingNotes(false);
  }, [contactId, supabase]);

  const fetchCustomFields = useCallback(async () => {
    if (!contactId) return;
    setLoadingCustom(true);

    const [fieldsRes, valuesRes] = await Promise.all([
      supabase.from('custom_fields').select('*').order('field_name'),
      supabase
        .from('contact_custom_values')
        .select('*')
        .eq('contact_id', contactId),
    ]);

    if (fieldsRes.data) setCustomFields(fieldsRes.data);
    if (valuesRes.data) {
      const map: Record<string, string> = {};
      valuesRes.data.forEach((v) => {
        map[v.custom_field_id] = v.value ?? '';
      });
      setCustomValues(map);
    }
    setLoadingCustom(false);
  }, [contactId, supabase]);

  const fetchDeals = useCallback(async () => {
    if (!contactId) return;
    setLoadingDeals(true);
    const { data } = await supabase
      .from('deals')
      .select('*, stage:pipeline_stages(*)')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false });
    setDeals((data ?? []) as Deal[]);
    setLoadingDeals(false);
  }, [contactId, supabase]);

  useEffect(() => {
    if (open && contactId) {
      fetchContact();
      fetchConversations();
      fetchTags();
      fetchNotes();
      fetchCustomFields();
      fetchDeals();
    }
  }, [
    open,
    contactId,
    fetchContact,
    fetchConversations,
    fetchTags,
    fetchNotes,
    fetchCustomFields,
    fetchDeals,
  ]);

  // Closing the sheet always returns it to view mode so the next contact
  // opened never lands on a stale edit form.
  function handleOpenChange(next: boolean) {
    if (!next) setMode('view');
    onOpenChange(next);
  }

  async function copyPhone() {
    if (!contact) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopiedPhone(true);
    setTimeout(() => setCopiedPhone(false), 2000);
  }

  function goToInbox(conversationId: string) {
    handleOpenChange(false);
    router.push(inboxConversationHref(conversationId));
  }

  /**
   * Primary action. Reuses the contact's most recent conversation when
   * one exists; otherwise creates an empty open conversation (the inbox
   * thread then offers "send a template to start the conversation") and
   * deep-links into it via the inbox's `?c=` support.
   */
  async function openConversation() {
    if (!contact) return;
    const existing = conversations[0];
    if (existing) {
      goToInbox(existing.id);
      return;
    }

    if (!canSend || !accountId || !user) {
      toast.error(t('You do not have permission to start conversations'));
      return;
    }

    setOpeningConversation(true);
    const { data, error } = await supabase
      .from('conversations')
      .insert({
        user_id: user.id,
        account_id: accountId,
        contact_id: contact.id,
        status: 'open',
        unread_count: 0,
      })
      .select('id')
      .single();

    setOpeningConversation(false);
    if (error || !data) {
      toast.error(t('Failed to start conversation'));
      return;
    }
    goToInbox(data.id as string);
  }

  async function saveDetails() {
    if (!contactId || !editPhone.trim()) {
      toast.error(t('Phone number is required'));
      return;
    }

    setSavingDetails(true);
    const { error } = await supabase
      .from('contacts')
      .update({
        name: editName.trim() || null,
        phone: editPhone.trim(),
        email: editEmail.trim() || null,
        company: editCompany.trim() || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', contactId);

    if (error) {
      toast.error(t('Failed to update contact'));
    } else {
      toast.success(t('Contact updated'));
      setMode('view');
      fetchContact();
      onUpdated();
    }
    setSavingDetails(false);
  }

  function cancelEdit() {
    if (contact) {
      setEditName(contact.name ?? '');
      setEditPhone(contact.phone);
      setEditEmail(contact.email ?? '');
      setEditCompany(contact.company ?? '');
    }
    setMode('view');
  }

  async function toggleTag(tagId: string) {
    if (!contactId) return;
    setSavingTags(true);

    const isSelected = contactTagIds.includes(tagId);

    if (isSelected) {
      const { error } = await supabase
        .from('contact_tags')
        .delete()
        .eq('contact_id', contactId)
        .eq('tag_id', tagId);
      if (!error) {
        setContactTagIds((prev) => prev.filter((id) => id !== tagId));
        onUpdated();
      }
    } else {
      const { error } = await supabase
        .from('contact_tags')
        .insert({ contact_id: contactId, tag_id: tagId });
      if (!error) {
        setContactTagIds((prev) => [...prev, tagId]);
        onUpdated();
      }
    }
    setSavingTags(false);
  }

  async function addNote() {
    if (!contactId || !newNote.trim()) return;
    setSavingNote(true);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const sessionUser = session?.user;
    if (!sessionUser || !accountId) {
      toast.error(t('Not authenticated'));
      setSavingNote(false);
      return;
    }

    const { error } = await supabase.from('contact_notes').insert({
      contact_id: contactId,
      account_id: accountId,
      user_id: sessionUser.id,
      note_text: newNote.trim(),
    });

    if (error) {
      toast.error(t('Failed to add note'));
    } else {
      setNewNote('');
      fetchNotes();
      toast.success(t('Note added'));
    }
    setSavingNote(false);
  }

  async function deleteNote(noteId: string) {
    const { error } = await supabase
      .from('contact_notes')
      .delete()
      .eq('id', noteId);

    if (error) {
      toast.error(t('Failed to delete note'));
    } else {
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      toast.success(t('Note deleted'));
    }
  }

  async function saveCustomFields() {
    if (!contactId) return;
    setSavingCustom(true);

    try {
      // Delete existing values and re-insert
      await supabase
        .from('contact_custom_values')
        .delete()
        .eq('contact_id', contactId);

      const rows = Object.entries(customValues)
        .filter(([, val]) => val.trim())
        .map(([fieldId, val]) => ({
          contact_id: contactId,
          custom_field_id: fieldId,
          value: val.trim(),
        }));

      if (rows.length > 0) {
        const { error } = await supabase
          .from('contact_custom_values')
          .insert(rows);
        if (error) throw error;
      }

      toast.success(t('Custom fields saved'));
    } catch {
      toast.error(t('Failed to save custom fields'));
    }
    setSavingCustom(false);
  }

  function getInitials(name?: string | null) {
    if (!name) return '?';
    return name
      .split(' ')
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }

  function relativeTime(iso?: string | null) {
    if (!iso) return '';
    return formatDistanceToNow(new Date(iso), {
      addSuffix: true,
      locale: language === 'pt-BR' ? ptBR : undefined,
    });
  }

  const hasConversation = conversations.length > 0;
  const displayName = contact?.name || contact?.phone || '';

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        className="bg-popover border-border text-popover-foreground w-full p-0 data-[side=right]:sm:max-w-md"
      >
        {loading || !contact ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : (
          <div className="flex flex-col h-full">
            {/* Header: identity block + primary actions */}
            <SheetHeader className="p-4 pb-3 border-b border-border/50 gap-3">
              <div className="flex items-start gap-3 pr-8">
                <Avatar className="size-14 bg-muted border border-border">
                  {contact.avatar_url && (
                    <AvatarImage src={contact.avatar_url} alt={displayName} />
                  )}
                  <AvatarFallback className="bg-primary/10 text-primary text-base font-semibold">
                    {getInitials(contact.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <SheetTitle className="text-popover-foreground text-lg leading-tight truncate">
                    {contact.name || contact.phone}
                  </SheetTitle>
                  <SheetDescription className="sr-only">
                    {t('Contact details')}
                  </SheetDescription>
                  {contact.anonymized_at && (
                    <span
                      className="mt-1 inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                      title={t('Personal data removed (LGPD)')}
                    >
                      <ShieldCheck className="size-3" aria-hidden />
                      {t('Anonymized')}
                    </span>
                  )}
                  {contact.company && (
                    <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground truncate">
                      <Building2 className="size-3 shrink-0" />
                      <span className="truncate">{contact.company}</span>
                    </p>
                  )}
                  <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                    <button
                      type="button"
                      onClick={copyPhone}
                      title={t('Copy phone')}
                      className="flex max-w-full items-center gap-1.5 hover:text-primary transition-colors cursor-pointer"
                    >
                      <Phone className="size-3 shrink-0" />
                      <span className="font-mono truncate">{contact.phone}</span>
                      {copiedPhone ? (
                        <Check className="size-3 text-primary shrink-0" />
                      ) : (
                        <Copy className="size-3 shrink-0 opacity-70" />
                      )}
                    </button>
                    {contact.email && (
                      <span className="flex max-w-full items-center gap-1.5">
                        <Mail className="size-3 shrink-0" />
                        <span className="truncate">{contact.email}</span>
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {mode === 'view' ? (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={openConversation}
                    disabled={
                      openingConversation ||
                      (!hasConversation && (!canSend || !!contact.anonymized_at))
                    }
                    className="flex-1 bg-primary hover:bg-primary/90 text-primary-foreground"
                  >
                    {openingConversation ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <MessageCircle className="size-3.5" />
                    )}
                    {hasConversation
                      ? t('Open conversation')
                      : t('Start conversation')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setMode('edit')}
                    disabled={!!contact.anonymized_at}
                    title={contact.anonymized_at ? t('Anonymized contacts cannot be edited') : undefined}
                    className="border-border text-foreground hover:bg-muted"
                  >
                    <Pencil className="size-3.5" />
                    {t('Edit')}
                  </Button>
                  {onDelete && (
                    <Button
                      size="icon-sm"
                      variant="outline"
                      aria-label={t('Delete contact')}
                      title={t('Delete contact')}
                      onClick={() => onDelete(contact)}
                      className="border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 hover:bg-destructive/10"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-md bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground">
                  <Pencil className="size-3" />
                  {t('Editing contact')}
                </div>
              )}
            </SheetHeader>

            {mode === 'edit' ? (
              /* Edit mode: the same fields as before, but reached on demand
                 instead of being the entire panel. */
              <div className="flex-1 overflow-y-auto px-4 py-4">
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">{t('Name')}</Label>
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="bg-muted border-border text-foreground h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                      {t('Phone')} <span className="text-red-400">*</span>
                    </Label>
                    <Input
                      value={editPhone}
                      onChange={(e) => setEditPhone(e.target.value)}
                      className="bg-muted border-border text-foreground h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">{t('Email')}</Label>
                    <Input
                      value={editEmail}
                      onChange={(e) => setEditEmail(e.target.value)}
                      className="bg-muted border-border text-foreground h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">{t('Company')}</Label>
                    <Input
                      value={editCompany}
                      onChange={(e) => setEditCompany(e.target.value)}
                      className="bg-muted border-border text-foreground h-8 text-sm"
                    />
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      onClick={saveDetails}
                      disabled={savingDetails}
                      className="bg-primary hover:bg-primary/90 text-primary-foreground flex-1"
                      size="sm"
                    >
                      {savingDetails ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Save className="size-3.5" />
                      )}
                      {t('Save changes')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={cancelEdit}
                      disabled={savingDetails}
                      className="border-border text-muted-foreground hover:bg-muted"
                    >
                      <X className="size-3.5" />
                      {t('Cancel')}
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <Tabs defaultValue="conversations" className="flex-1 flex flex-col min-h-0">
                {/* Tab strip. Earlier build overflowed the sheet (five long
                    labels in a fixed-height list). Labels are short, the
                    list is full-width and wraps if the sheet ever gets
                    narrower than the strip. */}
                <TabsList className="bg-muted/50 border-b border-border mx-4 mt-3 flex w-auto flex-wrap group-data-horizontal/tabs:h-auto">
                  <TabsTrigger
                    value="conversations"
                    className="text-xs px-2 data-active:bg-muted data-active:text-primary text-muted-foreground"
                  >
                    {t('Conversations')}
                  </TabsTrigger>
                  <TabsTrigger
                    value="tags"
                    className="text-xs px-2 data-active:bg-muted data-active:text-primary text-muted-foreground"
                  >
                    {t('Tags')}
                  </TabsTrigger>
                  <TabsTrigger
                    value="notes"
                    className="text-xs px-2 data-active:bg-muted data-active:text-primary text-muted-foreground"
                  >
                    {t('Notes')}
                  </TabsTrigger>
                  <TabsTrigger
                    value="custom"
                    className="text-xs px-2 data-active:bg-muted data-active:text-primary text-muted-foreground"
                  >
                    {t('Fields')}
                  </TabsTrigger>
                  <TabsTrigger
                    value="deals"
                    className="text-xs px-2 data-active:bg-muted data-active:text-primary text-muted-foreground"
                  >
                    {t('Deals')}
                  </TabsTrigger>
                  {calendarEnabled && (
                    <TabsTrigger
                      value="calendar"
                      className="text-xs px-2 data-active:bg-muted data-active:text-primary text-muted-foreground"
                    >
                      {t('Calendar')}
                    </TabsTrigger>
                  )}
                  <TabsTrigger
                    value="privacy"
                    className="text-xs px-2 data-active:bg-muted data-active:text-primary text-muted-foreground"
                  >
                    {t('Privacy')}
                  </TabsTrigger>
                </TabsList>

                {/* Conversations Tab (default) */}
                <TabsContent value="conversations" className="flex-1 overflow-y-auto px-4 py-3">
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    {t('Previous conversations')}
                  </p>
                  {loadingConversations ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : conversations.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-8 text-center">
                      <MessageSquare className="size-6 text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">
                        {t('No conversations with this contact yet.')}
                      </p>
                      {canSend && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={openConversation}
                          disabled={openingConversation}
                          className="mt-1 border-border text-foreground hover:bg-muted"
                        >
                          {openingConversation ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <MessageCircle className="size-3.5" />
                          )}
                          {t('Start conversation')}
                        </Button>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {conversations.map((conv) => (
                        <button
                          key={conv.id}
                          type="button"
                          onClick={() => goToInbox(conv.id)}
                          className="group w-full rounded-lg border border-border bg-muted/40 p-3 text-left transition-colors hover:bg-muted hover:border-primary/40 cursor-pointer"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                              <span
                                className={cn(
                                  'size-2 rounded-full shrink-0',
                                  STATUS_DOT[conv.status]
                                )}
                              />
                              {t(STATUS_LABEL_KEY[conv.status])}
                              {conv.unread_count > 0 && (
                                <span className="ml-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                                  {conv.unread_count}
                                </span>
                              )}
                            </span>
                            <span className="shrink-0 text-[11px] text-muted-foreground">
                              {relativeTime(conv.last_message_at ?? conv.created_at)}
                            </span>
                          </div>
                          <p className="mt-1.5 text-sm text-foreground/90 line-clamp-2 break-words">
                            {conv.last_message_text || t('No messages yet')}
                          </p>
                          <span className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground group-hover:text-primary transition-colors">
                            <ArrowUpRight className="size-3" />
                            {t('Open in inbox')}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </TabsContent>

                {/* Tags Tab */}
                <TabsContent value="tags" className="flex-1 overflow-y-auto px-4 py-3">
                  <div className="space-y-3">
                    <p className="text-xs text-muted-foreground">
                      {t('Click a tag to add or remove it from this contact.')}
                    </p>
                    {allTags.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        {t('No tags available. Create tags in Settings.')}
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {allTags.map((tag) => {
                          const selected = contactTagIds.includes(tag.id);
                          return (
                            <button
                              key={tag.id}
                              type="button"
                              onClick={() => toggleTag(tag.id)}
                              disabled={savingTags}
                              className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium transition-all cursor-pointer ${
                                selected
                                  ? 'ring-2 ring-primary ring-offset-1 ring-offset-border'
                                  : 'opacity-50 hover:opacity-80'
                              }`}
                              style={{
                                backgroundColor: tag.color + '20',
                                color: tag.color,
                              }}
                            >
                              {selected && <Check className="size-3 mr-1" />}
                              {tag.name}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </TabsContent>

                {/* Notes Tab */}
                <TabsContent value="notes" className="flex-1 flex flex-col min-h-0 px-4 py-3">
                  <div className="space-y-2 mb-3">
                    <Textarea
                      value={newNote}
                      onChange={(e) => setNewNote(e.target.value)}
                      placeholder={t('Write a note...')}
                      className="bg-muted border-border text-foreground placeholder:text-muted-foreground min-h-[60px] text-sm resize-none"
                    />
                    <Button
                      onClick={addNote}
                      disabled={!newNote.trim() || savingNote}
                      className="bg-primary hover:bg-primary/90 text-primary-foreground"
                      size="sm"
                    >
                      {savingNote ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Plus className="size-3.5" />
                      )}
                      {t('Add note')}
                    </Button>
                  </div>

                  <div className="flex-1 overflow-y-auto space-y-2">
                    {loadingNotes ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 className="size-5 animate-spin text-muted-foreground" />
                      </div>
                    ) : notes.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-8">
                        {t('No notes yet.')}
                      </p>
                    ) : (
                      notes.map((note) => (
                        <div
                          key={note.id}
                          className="rounded-lg bg-muted/50 border border-border/50 p-3 group"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-sm text-muted-foreground whitespace-pre-wrap flex-1">
                              {note.note_text}
                            </p>
                            <button
                              type="button"
                              onClick={() => deleteNote(note.id)}
                              aria-label={t('Delete note')}
                              className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-400 transition-all cursor-pointer shrink-0"
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          </div>
                          <p className="text-xs text-muted-foreground mt-1.5">
                            {new Date(note.created_at).toLocaleDateString('pt-BR', {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </p>
                        </div>
                      ))
                    )}
                  </div>
                </TabsContent>

                {/* Custom Fields Tab */}
                <TabsContent value="custom" className="flex-1 overflow-y-auto px-4 py-3">
                  {loadingCustom ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : customFields.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      {t('No custom fields defined. Create them in Settings.')}
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {customFields.map((field) => (
                        <div key={field.id} className="space-y-1.5">
                          <Label className="text-muted-foreground text-xs capitalize">
                            {field.field_name}
                          </Label>
                          <Input
                            value={customValues[field.id] ?? ''}
                            onChange={(e) =>
                              setCustomValues((prev) => ({
                                ...prev,
                                [field.id]: e.target.value,
                              }))
                            }
                            className="bg-muted border-border text-foreground h-8 text-sm placeholder:text-muted-foreground"
                          />
                        </div>
                      ))}
                      <Button
                        onClick={saveCustomFields}
                        disabled={savingCustom}
                        className="bg-primary hover:bg-primary/90 text-primary-foreground w-full"
                        size="sm"
                      >
                        {savingCustom ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Save className="size-3.5" />
                        )}
                        {t('Save custom fields')}
                      </Button>
                    </div>
                  )}
                </TabsContent>

                {/* Deals Tab */}
                <TabsContent value="deals" className="flex-1 overflow-y-auto px-4 py-3">
                  {loadingDeals ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="size-5 animate-spin text-primary" />
                    </div>
                  ) : deals.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      {t('No deals yet')}
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {deals.map((deal) => (
                        <div
                          key={deal.id}
                          className="rounded-lg border border-border bg-muted/50 p-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-sm font-medium text-foreground">
                              {deal.title}
                            </p>
                            {deal.stage && (
                              <span
                                className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                                style={{
                                  backgroundColor: `${deal.stage.color}20`,
                                  color: deal.stage.color,
                                }}
                              >
                                {deal.stage.name}
                              </span>
                            )}
                          </div>
                          <div className="mt-1.5 flex items-center justify-between text-xs text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <DollarSign className="size-3" />
                              {formatCurrency(
                                deal.value ?? 0,
                                deal.currency || defaultCurrency,
                              )}
                            </span>
                            {deal.status && deal.status !== 'open' && (
                              <span
                                className={
                                  deal.status === 'won'
                                    ? 'text-primary'
                                    : 'text-red-400'
                                }
                              >
                                {t(deal.status === 'won' ? 'Won' : 'Lost')}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </TabsContent>

                {/* Calendar Tab (migration 040): the contact's next appointments + "+". */}
                {calendarEnabled && (
                  <TabsContent value="calendar" className="flex-1 overflow-y-auto px-4 py-3">
                    <LinkedEvents contactId={contact.id} readOnly={!canSend} label={t('Upcoming appointments')} />
                  </TabsContent>
                )}

                {/* Privacy Tab (LGPD, migration 035) */}
                <TabsContent value="privacy" className="flex-1 overflow-y-auto px-4 py-3">
                  <p className="mb-3 text-xs text-muted-foreground">
                    {t(
                      'Record the consent this contact gave, export everything the workspace holds about them, or remove their personal data for good.',
                    )}
                  </p>
                  <ContactPrivacySection
                    contact={contact}
                    onChanged={() => {
                      fetchContact();
                      // Message previews are scrubbed too.
                      fetchConversations();
                      onUpdated();
                    }}
                  />
                </TabsContent>
              </Tabs>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
