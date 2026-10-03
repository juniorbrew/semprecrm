'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import {
  findConversationByContact,
  inboxConversationHref,
} from '@/lib/conversations/find-by-contact';
import { toast } from 'sonner';
import type { Contact, Tag, ContactTag } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Search,
  Plus,
  Upload,
  Trash2,
  Loader2,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  Ban,
  Rows4,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import {
  CONTACTS_COPY,
  ContactListRow,
  readContactsDensity,
  writeContactsDensity,
  type ContactsDensity,
} from '@/components/contacts/contact-list-row';
import { ContactForm } from '@/components/contacts/contact-form';
import { ContactDetailView } from '@/components/contacts/contact-detail-view';
import { ImportModal } from '@/components/contacts/import-modal';
import { CustomFieldsManager } from '@/components/contacts/custom-fields-manager';
import { useCan } from '@/hooks/use-can';
import { useLanguage } from '@/hooks/use-language';
import { GatedButton } from '@/components/ui/gated-button';
import { Checkbox } from '@/components/ui/checkbox';

const PAGE_SIZE = 25;
const DELETE_CHUNK = 10;
const TH = 'h-9 px-2 text-left text-xs font-medium text-muted-foreground';

interface ContactWithTags extends Contact {
  tags?: Tag[];
}

/**
 * Deletes go through DELETE /api/contacts (admin+): the server removes
 * the contacts' chat media and profile photos, scrubs the personal text
 * the delete would leave behind and writes the audit row. Chunks of 10
 * (each contact is several storage + DB round trips; keeps a request short). Returns the deleted ids and the first error.
 */
async function deleteContactsOnServer(
  ids: string[],
): Promise<{ deleted: string[]; error: string | null }> {
  const deleted: string[] = [];
  let error: string | null = null;
  for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
    try {
      const res = await fetch('/api/contacts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ids.slice(i, i + DELETE_CHUNK) }),
      });
      const body = (await res.json().catch(() => null)) as {
        deleted?: string[];
        failed?: { error?: string }[];
        error?: string;
      } | null;
      deleted.push(...(body?.deleted ?? []));
      error ??= body?.error ?? body?.failed?.[0]?.error ?? (res.ok ? null : `HTTP ${res.status}`);
      // 403 (agent) / 429: the next chunks would fail the same way.
      if (res.status === 403 || res.status === 429) break;
    } catch {
      error ??= 'Falha de conexão ao excluir.';
      break;
    }
  }
  return { deleted, error };
}

export default function ContactsPage() {
  const supabase = createClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t, language } = useLanguage();
  const canEdit = useCan('send-messages');
  const canEditSettings = useCan('edit-settings');
  const copy = CONTACTS_COPY[language] ?? CONTACTS_COPY['pt-BR'];
  const userId = useAuth().user?.id;

  // Row density, per user on this device. Read after mount (localStorage
  // in the initializer would be a hydration mismatch), like the inbox list.
  const [density, setDensity] = useState<ContactsDensity>('comfortable');
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (userId) setDensity(readContactsDensity(userId));
  }, [userId]);
  const toggleDensity = useCallback(() => {
    setDensity((d) => {
      const next: ContactsDensity = d === 'compact' ? 'comfortable' : 'compact';
      if (userId) writeContactsDensity(userId, next);
      return next;
    });
  }, [userId]);

  const [contacts, setContacts] = useState<ContactWithTags[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  // "Descadastrados" — only contacts with opted_out_at set (migration 030).
  const [optedOutOnly, setOptedOutOnly] = useState(false);

  // Modals
  const [formOpen, setFormOpen] = useState(false);
  const [editContact, setEditContact] = useState<Contact | null>(null);
  const [editContactTags, setEditContactTags] = useState<ContactTag[]>([]);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailContactId, setDetailContactId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [customFieldsOpen, setCustomFieldsOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Bulk selection (page-scoped — only the loaded rows are selectable)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  // All tags for display
  const [tagsMap, setTagsMap] = useState<Record<string, Tag>>({});

  const fetchTags = useCallback(async () => {
    const { data } = await supabase.from('tags').select('*');
    if (data) {
      const map: Record<string, Tag> = {};
      data.forEach((t) => (map[t.id] = t));
      setTagsMap(map);
    }
  }, [supabase]);

  const fetchContacts = useCallback(async () => {
    setLoading(true);
    // The visible rows are about to change — drop any selection that
    // referred to the old page/search results so the bulk bar can't
    // act on rows the user can no longer see.
    setSelected(new Set());

    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    let query = supabase
      .from('contacts')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);

    if (search.trim()) {
      const term = `%${search.trim()}%`;
      query = query.or(`name.ilike.${term},phone.ilike.${term},email.ilike.${term}`);
    }
    if (optedOutOnly) {
      query = query.not('opted_out_at', 'is', null);
    }

    const { data, count, error } = await query;

    if (error) {
      toast.error(t('Failed to load contacts'));
      setLoading(false);
      return;
    }

    setTotalCount(count ?? 0);

    if (!data || data.length === 0) {
      setContacts([]);
      setLoading(false);
      return;
    }

    // Fetch tags for these contacts
    const contactIds = data.map((c) => c.id);
    const { data: contactTags } = await supabase
      .from('contact_tags')
      .select('contact_id, tag_id')
      .in('contact_id', contactIds);

    const tagsByContact: Record<string, string[]> = {};
    contactTags?.forEach((ct) => {
      if (!tagsByContact[ct.contact_id]) tagsByContact[ct.contact_id] = [];
      tagsByContact[ct.contact_id].push(ct.tag_id);
    });

    const enriched: ContactWithTags[] = data.map((c) => ({
      ...c,
      tags: (tagsByContact[c.id] ?? [])
        .map((tid) => tagsMap[tid])
        .filter(Boolean),
    }));

    setContacts(enriched);
    setLoading(false);
  }, [supabase, page, search, tagsMap, optedOutOnly, t]);

  // Load-once-on-mount-ish data fetches. Each setter inside runs
  // inside an async promise completion (Supabase await), not
  // synchronously in the effect body, so the cascade the lint rule
  // warns about doesn't apply here.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchTags();
  }, [fetchTags]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContacts();
  }, [fetchContacts]);

  function openAddForm() {
    setEditContact(null);
    setEditContactTags([]);
    setFormOpen(true);
  }

  async function openEditForm(contact: Contact) {
    const { data } = await supabase
      .from('contact_tags')
      .select('*')
      .eq('contact_id', contact.id);
    setEditContact(contact);
    setEditContactTags(data ?? []);
    setFormOpen(true);
  }

  function openDetail(contactId: string) {
    setDetailContactId(contactId);
    setDetailOpen(true);
  }

  // `?contact=<id>` (calendar links, push clicks) opens that contact's
  // detail sheet on arrival. Applied once so closing the sheet sticks.
  const deepLinkContactId = searchParams.get('contact');
  useEffect(() => {
    if (!deepLinkContactId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDetailContactId(deepLinkContactId);
    setDetailOpen(true);
  }, [deepLinkContactId]);

  /**
   * Row shortcut to the contact's WhatsApp thread. Uses the same
   * "newest activity wins" lookup as the detail panel and the deal
   * drawer. A contact that never talked to us lands in the detail
   * panel instead, where "Iniciar conversa" can create the thread.
   */
  async function openConversationFor(contact: Contact) {
    const existing = await findConversationByContact(supabase, contact.id);
    if (existing) {
      router.push(inboxConversationHref(existing.id));
      return;
    }
    toast.info(t('No conversations with this contact yet.'));
    openDetail(contact.id);
  }

  function confirmDelete(contact: Contact) {
    setDeleteTarget(contact);
    setDeleteConfirmOpen(true);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);

    const { deleted, error } = await deleteContactsOnServer([deleteTarget.id]);

    if (deleted.length === 0) {
      toast.error(error ?? 'Não foi possível excluir o contato.');
    } else {
      toast.success(t('Contact deleted'));
      // The detail sheet may be showing the contact we just removed.
      if (detailContactId === deleteTarget.id) {
        setDetailOpen(false);
        setDetailContactId(null);
      }
      fetchContacts();
    }

    setDeleting(false);
    setDeleteConfirmOpen(false);
    setDeleteTarget(null);
  }

  const allOnPageSelected =
    contacts.length > 0 && contacts.every((c) => selected.has(c.id));
  const someOnPageSelected = contacts.some((c) => selected.has(c.id));

  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        contacts.forEach((c) => next.delete(c.id));
      } else {
        contacts.forEach((c) => next.add(c.id));
      }
      return next;
    });
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBulkDelete() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setDeleting(true);

    const { deleted, error } = await deleteContactsOnServer(ids);

    if (error) toast.error(error);
    if (deleted.length > 0) {
      toast.success(`${deleted.length} contact${deleted.length === 1 ? '' : 's'} deleted`);
      setSelected((prev) => {
        const next = new Set(prev);
        deleted.forEach((id) => next.delete(id));
        return next;
      });
      fetchContacts();
    }

    setDeleting(false);
    setBulkDeleteOpen(false);
  }

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const hasNext = page < totalPages - 1;
  const hasPrev = page > 0;

  return (
    <div className="space-y-4">
      {/* Header: title + count, one filled action */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{copy.title}</h1>
        {totalCount > 0 && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-bold tabular-nums text-muted-foreground">
            {totalCount}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {canEditSettings && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCustomFieldsOpen(true)}
              aria-label={copy.customFields}
              title={copy.customFields}
              className="text-muted-foreground hover:text-foreground"
            >
              <SlidersHorizontal />
              <span className="hidden md:inline">{copy.customFields}</span>
            </Button>
          )}
          <GatedButton
            variant="ghost"
            size="sm"
            canAct={canEdit}
            gateReason="add or import contacts"
            onClick={() => setImportOpen(true)}
            className="text-muted-foreground hover:text-foreground"
          >
            <Upload />
            {copy.import}
          </GatedButton>
          <GatedButton
            size="sm"
            canAct={canEdit}
            gateReason="add or import contacts"
            onClick={openAddForm}
          >
            <Plus />
            {copy.newContact}
          </GatedButton>
        </div>
      </div>

      {/* Search + filter pill + density */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 max-w-xs flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              // Reset pagination when the query changes — the result
              // set shrinks/grows, page N may no longer be valid.
              setPage(0);
            }}
            placeholder={copy.search}
            aria-label={copy.search}
            className="h-8 pl-8 text-sm"
          />
        </div>
        <button
          type="button"
          aria-pressed={optedOutOnly}
          onClick={() => {
            setOptedOutOnly((v) => !v);
            setPage(0);
          }}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
            optedOutOnly
              ? 'bg-primary/15 text-primary'
              : 'bg-muted text-muted-foreground hover:text-foreground',
          )}
        >
          <Ban className="size-3.5" aria-hidden />
          {copy.optedOut}
        </button>
        <button
          type="button"
          onClick={toggleDensity}
          aria-pressed={density === 'compact'}
          aria-label={copy.compact}
          title={copy.compact}
          data-testid="contacts-density-toggle"
          className={cn(
            'ml-auto inline-flex size-7 items-center justify-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
            density === 'compact'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          <Rows4 className="size-3.5" />
        </button>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 rounded-md bg-primary/10 px-3 py-1.5">
          <p className="text-sm font-medium text-foreground" aria-live="polite">
            {copy.selected(selected.size)}
          </p>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set())}
              className="text-muted-foreground hover:text-foreground"
            >
              {copy.clear}
            </Button>
            <GatedButton
              variant="destructive"
              size="sm"
              canAct={canEdit}
              gateReason="delete contacts"
              onClick={() => setBulkDeleteOpen(true)}
            >
              <Trash2 />
              {copy.deleteSelected}
            </GatedButton>
          </div>
        </div>
      )}

      {/* List: card-less table, sticky header, hairline rows */}
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-background">
          <tr className="border-y border-border">
            <th scope="col" className="h-9 w-10 pl-3 pr-1 text-left">
              <Checkbox
                checked={allOnPageSelected}
                indeterminate={!allOnPageSelected && someOnPageSelected}
                onCheckedChange={toggleSelectAll}
                disabled={contacts.length === 0}
                aria-label={copy.selectAll}
              />
            </th>
            <th scope="col" className={TH}>{copy.colContact}</th>
            <th scope="col" className={cn(TH, 'hidden md:table-cell')}>{copy.colEmail}</th>
            <th scope="col" className={cn(TH, 'hidden md:table-cell')}>{copy.colTags}</th>
            <th scope="col" className={cn(TH, 'hidden lg:table-cell')}>{copy.colCreated}</th>
            <th scope="col" className="w-px pr-3">
              <span className="sr-only">{copy.colActions}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={6} className="py-12 text-center">
                <span role="status" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  {copy.loading}
                </span>
              </td>
            </tr>
          ) : contacts.length === 0 ? (
            <tr>
              <td colSpan={6} className="py-12 text-center">
                <p className="text-sm text-muted-foreground">
                  {optedOutOnly ? copy.emptyOptedOut : search ? copy.emptySearch : copy.emptyAll}
                </p>
                {!search && !optedOutOnly && canEdit && (
                  <Button variant="outline" size="sm" onClick={openAddForm} className="mt-3">
                    <Plus />
                    {copy.addFirst}
                  </Button>
                )}
              </td>
            </tr>
          ) : (
            contacts.map((contact) => (
              <ContactListRow
                key={contact.id}
                contact={contact}
                tags={contact.tags ?? []}
                selected={selected.has(contact.id)}
                compact={density === 'compact'}
                createdLabel={new Date(contact.created_at).toLocaleDateString(language, {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
                copy={copy}
                onToggleSelect={() => toggleSelect(contact.id)}
                onOpen={() => openDetail(contact.id)}
                onOpenConversation={() => openConversationFor(contact)}
                onEdit={() => openEditForm(contact)}
                onDelete={() => confirmDelete(contact)}
              />
            ))
          )}
        </tbody>
      </table>

      {/* Pagination */}
      {totalPages > 1 && (
        <nav className="flex items-center justify-between" aria-label={copy.pagination}>
          <p className="text-xs tabular-nums text-muted-foreground">
            {copy.range(page * PAGE_SIZE + 1, Math.min((page + 1) * PAGE_SIZE, totalCount), totalCount)}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!hasPrev}
              onClick={() => setPage((p) => p - 1)}
              aria-label={copy.prev}
              className="text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft />
            </Button>
            <span className="px-2 text-xs tabular-nums text-muted-foreground">
              {copy.page(page + 1, totalPages)}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!hasNext}
              onClick={() => setPage((p) => p + 1)}
              aria-label={copy.next}
              className="text-muted-foreground hover:text-foreground"
            >
              <ChevronRight />
            </Button>
          </div>
        </nav>
      )}

      {/* Contact Form Dialog */}
      <ContactForm
        open={formOpen}
        onOpenChange={setFormOpen}
        contact={editContact}
        contactTags={editContactTags}
        onSaved={() => {
          fetchContacts();
          fetchTags();
        }}
        onViewExisting={(id) => {
          setFormOpen(false);
          openDetail(id);
        }}
      />

      {/* Contact Detail Sheet */}
      <ContactDetailView
        open={detailOpen}
        onOpenChange={setDetailOpen}
        contactId={detailContactId}
        onUpdated={fetchContacts}
        onDelete={canEdit ? confirmDelete : undefined}
      />

      {/* Import Modal */}
      <ImportModal
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={fetchContacts}
      />

      {/* Custom Fields Manager (admin+) */}
      {canEditSettings && (
        <CustomFieldsManager
          open={customFieldsOpen}
          onOpenChange={setCustomFieldsOpen}
        />
      )}

      {/* Delete Confirmation */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">Excluir contato</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Are you sure you want to delete{' '}
              <span className="text-popover-foreground font-medium">
                {deleteTarget?.name || deleteTarget?.phone}
              </span>
              ? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setDeleteConfirmOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              Excluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Delete Confirmation */}
      <Dialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('Delete')} {selected.size} {selected.size === 1 ? t('Contact') : t('Contacts')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Are you sure you want to delete{' '}
              <span className="text-popover-foreground font-medium">
                {selected.size} {selected.size === 1 ? t('contact') : t('contacts')}
              </span>
              ? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setBulkDeleteOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={handleBulkDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              Excluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
