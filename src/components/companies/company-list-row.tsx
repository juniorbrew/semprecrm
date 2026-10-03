'use client';

import { Building2, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import type { Language } from '@/lib/i18n';
import { formatTaxId } from '@/lib/br/documents';
import { companyDisplayName, companyPlace, type CompanyListItem } from '@/lib/companies';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** Row density of the companies list, per user on this device. */
export type CompaniesDensity = 'comfortable' | 'compact';
const DENSITY_KEY_PREFIX = 'sempre:companies:density:';

export function readCompaniesDensity(userId: string): CompaniesDensity {
  try {
    return localStorage.getItem(DENSITY_KEY_PREFIX + userId) === 'compact' ? 'compact' : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

export function writeCompaniesDensity(userId: string, density: CompaniesDensity): void {
  try {
    localStorage.setItem(DENSITY_KEY_PREFIX + userId, density);
  } catch {
    // Persistence is best-effort.
  }
}

type MetaFields = Pick<CompanyListItem, 'razao_social' | 'nome_fantasia' | 'cnpj' | 'cidade' | 'uf'>;

/** "Razão social · CNPJ · Cidade/UF" — the one meta line under the name (razão only when it differs). */
export function companyMetaLine(company: MetaFields): string {
  const legal =
    company.nome_fantasia && company.nome_fantasia.trim() !== company.razao_social ? company.razao_social : null;
  return [legal, company.cnpj ? formatTaxId('pj', company.cnpj) : null, companyPlace(company)]
    .filter(Boolean)
    .join(' · ');
}

/** Two letters for the square avatar: first letters of the first two words. */
export function companyInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '').slice(0, 2)).toUpperCase();
}

export const COMPANIES_COPY = {
  'pt-BR': {
    title: 'Empresas',
    newCompany: 'Nova empresa',
    search: 'Buscar por nome ou CNPJ',
    compact: 'Lista compacta',
    colCompany: 'Empresa',
    colCity: 'Cidade',
    colContacts: 'Contatos',
    colActions: 'Ações',
    selected: (n: number) => (n === 1 ? '1 selecionada' : `${n} selecionadas`),
    clear: 'Limpar',
    delete: 'Excluir',
    deleteSelected: 'Excluir selecionadas',
    selectAll: 'Selecionar todas as empresas desta página',
    select: (name: string) => `Selecionar ${name}`,
    open: (name: string) => `Abrir ${name}`,
    more: (name: string) => `Mais ações para ${name}`,
    view: 'Ver detalhes',
    edit: 'Editar',
    contacts: (n: number) => (n === 1 ? '1 contato' : `${n} contatos`),
    loading: 'Carregando empresas…',
    emptyAll: 'Nenhuma empresa ainda.',
    emptySearch: 'Nenhuma empresa encontrada.',
    addFirst: 'Cadastrar a primeira empresa',
    range: (from: number, to: number, total: number) => `${from}–${to} de ${total}`,
    page: (p: number, total: number) => `Página ${p} de ${total}`,
    pagination: 'Paginação',
    prev: 'Página anterior',
    next: 'Próxima página',
    bulkTitle: (n: number) => (n === 1 ? 'Excluir 1 empresa' : `Excluir ${n} empresas`),
    bulkBody: 'Os contatos e negócios continuam; só deixam de apontar para estas empresas. Não dá para desfazer.',
    bulkDone: (n: number) => (n === 1 ? '1 empresa excluída' : `${n} empresas excluídas`),
    cancel: 'Cancelar',
  },
  'en-US': {
    title: 'Companies',
    newCompany: 'New company',
    search: 'Search by name or CNPJ',
    compact: 'Compact list',
    colCompany: 'Company',
    colCity: 'City',
    colContacts: 'Contacts',
    colActions: 'Actions',
    selected: (n: number) => `${n} selected`,
    clear: 'Clear',
    delete: 'Delete',
    deleteSelected: 'Delete selected',
    selectAll: 'Select all companies on this page',
    select: (name: string) => `Select ${name}`,
    open: (name: string) => `Open ${name}`,
    more: (name: string) => `More actions for ${name}`,
    view: 'View details',
    edit: 'Edit',
    contacts: (n: number) => (n === 1 ? '1 contact' : `${n} contacts`),
    loading: 'Loading companies…',
    emptyAll: 'No companies yet.',
    emptySearch: 'No companies match your search.',
    addFirst: 'Add your first company',
    range: (from: number, to: number, total: number) => `${from}–${to} of ${total}`,
    page: (p: number, total: number) => `Page ${p} of ${total}`,
    pagination: 'Pagination',
    prev: 'Previous page',
    next: 'Next page',
    bulkTitle: (n: number) => (n === 1 ? 'Delete 1 company' : `Delete ${n} companies`),
    bulkBody: 'Their contacts and deals are kept; they just stop pointing to these companies. This cannot be undone.',
    bulkDone: (n: number) => (n === 1 ? '1 company deleted' : `${n} companies deleted`),
    cancel: 'Cancel',
  },
} satisfies Record<Language, Record<string, unknown>>;

export type CompaniesCopy = (typeof COMPANIES_COPY)['pt-BR'];

export interface CompanyListRowProps {
  company: CompanyListItem;
  selected: boolean;
  compact: boolean;
  canEdit: boolean;
  copy: CompaniesCopy;
  onToggleSelect: () => void;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

const quickBtn =
  'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

/**
 * One company in the list — the sibling of ContactListRow. The quick bar
 * (edit) shows on hover / focus-within only and is hidden from the a11y
 * tree: the "…" menu holds the same actions for keyboard and touch.
 */
export function CompanyListRow({
  company,
  selected,
  compact,
  canEdit,
  copy,
  onToggleSelect,
  onOpen,
  onEdit,
  onDelete,
}: CompanyListRowProps) {
  const name = companyDisplayName(company);
  const meta = companyMetaLine(company);
  const place = companyPlace(company);
  const cell = compact ? 'py-1.5' : 'py-2.5';

  return (
    <tr
      data-selected={selected || undefined}
      onClick={onOpen}
      className={cn(
        'group/row cursor-pointer border-b border-border transition-colors duration-150 motion-reduce:transition-none',
        selected ? 'bg-primary/10' : 'hover:bg-muted/50',
      )}
    >
      <td
        onClick={(e) => e.stopPropagation()}
        className={cn('w-10 pl-3 pr-1 align-middle', cell, selected && 'shadow-[inset_3px_0_0_var(--primary)]')}
      >
        <Checkbox
          checked={selected}
          onCheckedChange={onToggleSelect}
          disabled={!canEdit}
          aria-label={copy.select(name)}
          className="flex"
        />
      </td>
      <td className={cn('min-w-0 px-2 align-middle', cell)}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          aria-label={copy.open(name)}
          className="flex w-full min-w-0 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            aria-hidden
            className={cn(
              'flex shrink-0 items-center justify-center rounded-[calc(var(--radius)-2px)] bg-muted font-semibold text-muted-foreground',
              compact ? 'size-7 text-[10px]' : 'size-9 text-xs',
            )}
          >
            {companyInitials(name) || <Building2 className="size-3.5" />}
          </span>
          <span className={cn('flex min-w-0 flex-1', compact ? 'flex-row items-baseline gap-2' : 'flex-col')}>
            <span className={cn('truncate text-sm font-medium text-foreground', compact && 'max-w-full shrink-0')}>
              {name}
            </span>
            {meta && <span className="min-w-0 truncate text-xs tabular-nums text-muted-foreground">{meta}</span>}
          </span>
        </button>
      </td>
      <td className={cn('hidden max-w-48 truncate px-2 align-middle text-sm text-muted-foreground md:table-cell', cell)}>
        {place || '—'}
      </td>
      <td
        className={cn('hidden whitespace-nowrap px-2 align-middle text-xs tabular-nums text-muted-foreground md:table-cell', cell)}
      >
        {company.contacts_count > 0 ? copy.contacts(company.contacts_count) : '—'}
      </td>
      <td onClick={(e) => e.stopPropagation()} className={cn('w-px whitespace-nowrap pl-1 pr-3 align-middle', cell)}>
        <div className="flex items-center justify-end gap-0.5">
          {canEdit && (
            <div
              aria-hidden
              className="hidden items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 group-focus-within/row:opacity-100 motion-reduce:transition-none md:flex"
            >
              <button type="button" tabIndex={-1} title={copy.edit} onClick={onEdit} className={quickBtn}>
                <Pencil className="size-3.5" />
              </button>
            </div>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={copy.more(name)}
                  className="text-muted-foreground hover:text-foreground"
                />
              }
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="border-border bg-popover">
              <DropdownMenuItem onClick={onOpen} className="text-popover-foreground focus:bg-muted focus:text-foreground">
                <Building2 className="size-4" />
                {copy.view}
              </DropdownMenuItem>
              {canEdit && (
                <>
                  <DropdownMenuItem onClick={onEdit} className="text-popover-foreground focus:bg-muted focus:text-foreground">
                    <Pencil className="size-4" />
                    {copy.edit}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator className="bg-border" />
                  <DropdownMenuItem variant="destructive" onClick={onDelete}>
                    <Trash2 className="size-4" />
                    {copy.delete}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </td>
    </tr>
  );
}
