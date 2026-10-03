'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ChevronLeft, ChevronRight, Loader2, Plus, Rows4, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { CompanyDetailSheet } from '@/components/companies/company-detail-sheet';
import { CompanyFormDialog } from '@/components/companies/company-form-dialog';
import {
  COMPANIES_COPY,
  CompanyListRow,
  readCompaniesDensity,
  writeCompaniesDensity,
  type CompaniesDensity,
} from '@/components/companies/company-list-row';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { GatedButton } from '@/components/ui/gated-button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { useLanguage } from '@/hooks/use-language';
import { AUDIT_ACTIONS } from '@/lib/audit';
import { recordAudit } from '@/lib/audit-client';
import {
  companyDisplayName,
  companyErrorMessage,
  deleteCompany,
  listCompanies,
  type Company,
  type CompanyListItem,
} from '@/lib/companies';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 25;
const TH = 'h-9 px-2 text-left text-xs font-medium text-muted-foreground';

type DeleteTarget = Pick<Company, 'id' | 'razao_social' | 'nome_fantasia' | 'cnpj'>;

/**
 * Empresas — the account's customer companies (pessoa jurídica), each
 * with any number of contacts and deals. Not the tenant (Settings →
 * Empresa). Viewer+ reads; agent+ creates, edits, links and deletes
 * (RLS, migration 054). Same list shape as Contatos.
 */
export default function CompaniesPage() {
  const { t, language } = useLanguage();
  const copy = COMPANIES_COPY[language] ?? COMPANIES_COPY['pt-BR'];
  const searchParams = useSearchParams();
  const canEdit = useCan('send-messages');
  const userId = useAuth().user?.id;

  // Row density, per user on this device. Read after mount (localStorage
  // in the initializer would be a hydration mismatch).
  const [density, setDensity] = useState<CompaniesDensity>('comfortable');
  useEffect(() => {
    if (userId) setDensity(readCompaniesDensity(userId));
  }, [userId]);
  const toggleDensity = useCallback(() => {
    setDensity((d) => {
      const next: CompaniesDensity = d === 'compact' ? 'comfortable' : 'compact';
      if (userId) writeCompaniesDensity(userId, next);
      return next;
    });
  }, [userId]);

  const [rows, setRows] = useState<CompanyListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(0);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Company | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailReload, setDetailReload] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Bulk selection (page-scoped — only the loaded rows are selectable).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    // The visible rows are about to change — drop a selection that
    // referred to the old page so the bulk bar never acts on hidden rows.
    setSelected(new Set());
    try {
      const out = await listCompanies(createClient(), { search: debounced, page, pageSize: PAGE_SIZE });
      setRows(out.rows);
      setTotal(out.total);
    } catch (err) {
      toast.error(t(companyErrorMessage(err)));
    } finally {
      setLoading(false);
    }
  }, [debounced, page, t]);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  // `?company=<id>` (links from contacts and deals) opens that company.
  const deepLinkId = searchParams.get('company');
  useEffect(() => {
    if (!deepLinkId) return;
    setDetailId(deepLinkId);
    setDetailOpen(true);
  }, [deepLinkId]);

  function openCreate() {
    setEditing(null);
    setFormOpen(true);
  }

  function openEdit(company: Company) {
    setEditing(company);
    setFormOpen(true);
  }

  function openDetail(id: string) {
    setDetailId(id);
    setDetailOpen(true);
  }

  /** Deletes one company + its audit row. Throws on failure. */
  async function removeCompany(target: DeleteTarget) {
    await deleteCompany(createClient(), target.id);
    void recordAudit({
      action: AUDIT_ACTIONS.COMPANY_DELETED,
      entityType: 'company',
      entityId: target.id,
      metadata: { name: target.razao_social, cnpj: target.cnpj },
    });
    if (detailId === target.id) {
      setDetailOpen(false);
      setDetailId(null);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await removeCompany(deleteTarget);
      toast.success(t('Company deleted'));
      setDeleteTarget(null);
      void fetchRows();
    } catch (err) {
      toast.error(t(companyErrorMessage(err)));
    } finally {
      setDeleting(false);
    }
  }

  async function handleBulkDelete() {
    const targets = rows.filter((r) => selected.has(r.id));
    if (targets.length === 0) return;
    setDeleting(true);
    let done = 0;
    for (const target of targets) {
      try {
        await removeCompany(target);
        done++;
      } catch (err) {
        toast.error(t(companyErrorMessage(err)));
        break;
      }
    }
    if (done > 0) toast.success(copy.bulkDone(done));
    setDeleting(false);
    setBulkDeleteOpen(false);
    void fetchRows();
  }

  const allOnPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someOnPageSelected = rows.some((r) => selected.has(r.id));

  function toggleSelectAll() {
    setSelected(allOnPageSelected ? new Set() : new Set(rows.map((r) => r.id)));
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      {/* Header: title + count, one filled action */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{copy.title}</h1>
        {total > 0 && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-bold tabular-nums text-muted-foreground">
            {total}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <GatedButton size="sm" canAct={canEdit} gateReason="add companies" onClick={openCreate}>
            <Plus />
            {copy.newCompany}
          </GatedButton>
        </div>
      </div>

      {/* Search + density */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 max-w-xs flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder={copy.search}
            aria-label={copy.search}
            className="h-8 pl-8 text-sm"
          />
        </div>
        <button
          type="button"
          onClick={toggleDensity}
          aria-pressed={density === 'compact'}
          aria-label={copy.compact}
          title={copy.compact}
          data-testid="companies-density-toggle"
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
          <p className="whitespace-nowrap text-sm font-medium text-foreground" aria-live="polite">
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
              gateReason="delete companies"
              onClick={() => setBulkDeleteOpen(true)}
            >
              <Trash2 />
              <span className="sm:hidden">{copy.delete}</span>
              <span className="hidden sm:inline">{copy.deleteSelected}</span>
            </GatedButton>
          </div>
        </div>
      )}

      {/* List: card-less table, sticky header, hairline rows */}
      <table className="w-full table-fixed text-sm md:table-auto">
        {/* Negative top = <main> padding, so the header sits flush under the app bar. */}
        <thead className="sticky -top-4 z-10 bg-background sm:-top-6">
          <tr className="border-y border-border">
            <th scope="col" className="h-9 w-10 pl-3 pr-1 text-left">
              <Checkbox
                checked={allOnPageSelected}
                indeterminate={!allOnPageSelected && someOnPageSelected}
                onCheckedChange={toggleSelectAll}
                disabled={rows.length === 0 || !canEdit}
                aria-label={copy.selectAll}
                className="flex"
              />
            </th>
            <th scope="col" className={TH}>{copy.colCompany}</th>
            <th scope="col" className={cn(TH, 'hidden md:table-cell')}>{copy.colCity}</th>
            <th scope="col" className={cn(TH, 'hidden md:table-cell')}>{copy.colContacts}</th>
            <th scope="col" className="w-11 pr-3 md:w-px">
              <span className="sr-only">{copy.colActions}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {loading && rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="py-12 text-center">
                <span role="status" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  {copy.loading}
                </span>
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="py-12 text-center">
                <p className="text-sm text-muted-foreground">{debounced ? copy.emptySearch : copy.emptyAll}</p>
                {!debounced && canEdit && (
                  <Button variant="outline" size="sm" onClick={openCreate} className="mt-3">
                    <Plus />
                    {copy.addFirst}
                  </Button>
                )}
              </td>
            </tr>
          ) : (
            rows.map((c) => (
              <CompanyListRow
                key={c.id}
                company={c}
                selected={selected.has(c.id)}
                compact={density === 'compact'}
                canEdit={canEdit}
                copy={copy}
                onToggleSelect={() => toggleSelect(c.id)}
                onOpen={() => openDetail(c.id)}
                onEdit={() => openEdit(c)}
                onDelete={() => setDeleteTarget(c)}
              />
            ))
          )}
        </tbody>
      </table>

      {/* Pagination */}
      {totalPages > 1 && (
        <nav className="flex items-center justify-between" aria-label={copy.pagination}>
          <p className="text-xs tabular-nums text-muted-foreground">
            {copy.range(page * PAGE_SIZE + 1, Math.min((page + 1) * PAGE_SIZE, total), total)}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              aria-label={copy.prev}
              className="text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft />
            </Button>
            <span className="px-2 text-xs tabular-nums text-muted-foreground">{copy.page(page + 1, totalPages)}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
              aria-label={copy.next}
              className="text-muted-foreground hover:text-foreground"
            >
              <ChevronRight />
            </Button>
          </div>
        </nav>
      )}

      <CompanyFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        company={editing}
        onSaved={(saved) => {
          void fetchRows();
          setDetailReload((n) => n + 1);
          if (!editing) openDetail(saved.id);
        }}
        onOpenExisting={openDetail}
      />

      <CompanyDetailSheet
        open={detailOpen}
        onOpenChange={setDetailOpen}
        companyId={detailId}
        reloadKey={detailReload}
        onEdit={openEdit}
        onDelete={(c) => setDeleteTarget(c)}
        onChanged={() => void fetchRows()}
      />

      <Dialog open={!!deleteTarget} onOpenChange={(open) => (!open ? setDeleteTarget(null) : undefined)}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t('Delete company')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('Delete')}{' '}
              <span className="font-medium text-popover-foreground">
                {deleteTarget ? companyDisplayName(deleteTarget) : ''}
              </span>
              ?{' '}
              {t('Its contacts and deals are kept; they just stop pointing to this company. This cannot be undone.')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="border-border bg-popover">
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('Cancel')}
            </Button>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={deleting}>
              {deleting ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('Delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkDeleteOpen} onOpenChange={(open) => (!deleting ? setBulkDeleteOpen(open) : undefined)}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{copy.bulkTitle(selected.size)}</DialogTitle>
            <DialogDescription className="text-muted-foreground">{copy.bulkBody}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="border-border bg-popover">
            <Button
              variant="outline"
              onClick={() => setBulkDeleteOpen(false)}
              disabled={deleting}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {copy.cancel}
            </Button>
            <Button variant="destructive" onClick={() => void handleBulkDelete()} disabled={deleting}>
              {deleting ? <Loader2 className="size-4 animate-spin" /> : null}
              {copy.delete}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
