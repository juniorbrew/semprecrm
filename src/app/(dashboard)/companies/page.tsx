'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Building2, ChevronLeft, ChevronRight, Loader2, MoreHorizontal, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { CompanyDetailSheet } from '@/components/companies/company-detail-sheet';
import { CompanyFormDialog } from '@/components/companies/company-form-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { GatedButton } from '@/components/ui/gated-button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCan } from '@/hooks/use-can';
import { useLanguage } from '@/hooks/use-language';
import { AUDIT_ACTIONS } from '@/lib/audit';
import { recordAudit } from '@/lib/audit-client';
import { formatTaxId } from '@/lib/br/documents';
import {
  companyDisplayName,
  companyErrorMessage,
  companyPlace,
  deleteCompany,
  listCompanies,
  type Company,
  type CompanyListItem,
} from '@/lib/companies';
import { createClient } from '@/lib/supabase/client';

const PAGE_SIZE = 25;

/**
 * Empresas — the account's customer companies (pessoa jurídica), each
 * with any number of contacts and deals. Not the tenant (Settings →
 * Empresa). Viewer+ reads; agent+ creates, edits, links and deletes
 * (RLS, migration 054).
 */
export default function CompaniesPage() {
  const { t } = useLanguage();
  const searchParams = useSearchParams();
  const canEdit = useCan('send-messages');

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
  const [deleteTarget, setDeleteTarget] = useState<Pick<Company, 'id' | 'razao_social' | 'nome_fantasia' | 'cnpj'> | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const fetchRows = useCallback(async () => {
    setLoading(true);
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

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteCompany(createClient(), deleteTarget.id);
      void recordAudit({
        action: AUDIT_ACTIONS.COMPANY_DELETED,
        entityType: 'company',
        entityId: deleteTarget.id,
        metadata: { name: deleteTarget.razao_social, cnpj: deleteTarget.cnpj },
      });
      toast.success(t('Company deleted'));
      if (detailId === deleteTarget.id) {
        setDetailOpen(false);
        setDetailId(null);
      }
      setDeleteTarget(null);
      void fetchRows();
    } catch (err) {
      toast.error(t(companyErrorMessage(err)));
    } finally {
      setDeleting(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('Companies')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('Your customer companies, with their contacts and deals.')}
          </p>
        </div>
        <GatedButton
          canAct={canEdit}
          gateReason="add companies"
          onClick={openCreate}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="size-4" />
          {t('New company')}
        </GatedButton>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
          placeholder={t('Search by name or CNPJ…')}
          aria-label={t('Search companies')}
          className="border-border bg-card pl-8 text-foreground placeholder:text-muted-foreground"
        />
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="text-muted-foreground">{t('Company')}</TableHead>
              <TableHead className="text-muted-foreground">CNPJ</TableHead>
              <TableHead className="hidden text-muted-foreground md:table-cell">{t('City')}</TableHead>
              <TableHead className="hidden text-muted-foreground md:table-cell">{t('Contacts')}</TableHead>
              <TableHead className="w-12 text-muted-foreground" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && rows.length === 0 ? (
              <TableRow className="border-border">
                <TableCell colSpan={5} className="py-12 text-center">
                  <Loader2 className="mx-auto size-6 animate-spin text-primary" />
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow className="border-border">
                <TableCell colSpan={5} className="py-12 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <Building2 className="size-8 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      {debounced ? t('No companies match your search.') : t('No companies yet.')}
                    </p>
                    {!debounced && canEdit ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={openCreate}
                        className="mt-2 border-border text-muted-foreground hover:bg-muted"
                      >
                        <Plus className="size-3.5" />
                        {t('Add your first company')}
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((c) => (
                <TableRow
                  key={c.id}
                  className="cursor-pointer border-border hover:bg-muted/50"
                  onClick={() => openDetail(c.id)}
                >
                  <TableCell className="font-medium text-foreground">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openDetail(c.id);
                      }}
                      className="group/name block max-w-full text-left"
                    >
                      <span className="block truncate group-hover/name:text-primary group-hover/name:underline underline-offset-2">
                        {companyDisplayName(c)}
                      </span>
                      {c.nome_fantasia && c.nome_fantasia.trim() !== c.razao_social ? (
                        <span className="block truncate text-[11px] font-normal text-muted-foreground">{c.razao_social}</span>
                      ) : null}
                    </button>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {c.cnpj ? formatTaxId('pj', c.cnpj) : '-'}
                  </TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                    {companyPlace(c) || '-'}
                  </TableCell>
                  <TableCell className="hidden text-sm tabular-nums text-muted-foreground md:table-cell">
                    {c.contacts_count}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('Actions')}
                            className="text-muted-foreground hover:text-foreground"
                          />
                        }
                      >
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="border-border bg-popover">
                        <DropdownMenuItem onClick={() => openDetail(c.id)}>
                          <Building2 className="size-4" />
                          {t('View details')}
                        </DropdownMenuItem>
                        {canEdit ? (
                          <>
                            <DropdownMenuItem onClick={() => openEdit(c)}>
                              <Pencil className="size-4" />
                              {t('Edit')}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onClick={() => setDeleteTarget(c)}>
                              <Trash2 className="size-4" />
                              {t('Delete')}
                            </DropdownMenuItem>
                          </>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {total > PAGE_SIZE ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {t('Page')} {page + 1} / {totalPages} · {total}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              aria-label={t('Previous page')}
              className="border-border"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => p + 1)}
              disabled={page >= totalPages - 1}
              aria-label={t('Next page')}
              className="border-border"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      ) : null}

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
    </div>
  );
}
