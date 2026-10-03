'use client';

import { MessageCircle, MoreHorizontal, Pencil, ShieldCheck, Trash2 } from 'lucide-react';
import type { Contact, Tag } from '@/types';
import type { Language } from '@/lib/i18n';
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
import { ContactAvatar } from '@/components/inbox/contact-avatar';

/** Row density of the contacts list, per user on this device. */
export type ContactsDensity = 'comfortable' | 'compact';
const DENSITY_KEY_PREFIX = 'sempre:contacts:density:';

export function readContactsDensity(userId: string): ContactsDensity {
  try {
    return localStorage.getItem(DENSITY_KEY_PREFIX + userId) === 'compact' ? 'compact' : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

export function writeContactsDensity(userId: string, density: ContactsDensity): void {
  try {
    localStorage.setItem(DENSITY_KEY_PREFIX + userId, density);
  } catch {
    // Persistence is best-effort.
  }
}

/** "Empresa · telefone" — the one meta line under the name. */
export function contactMetaLine(contact: Pick<Contact, 'company' | 'phone'>): string {
  return [contact.company?.trim(), contact.phone].filter(Boolean).join(' · ');
}

export const CONTACTS_COPY = {
  'pt-BR': {
    title: 'Contatos',
    newContact: 'Novo contato',
    import: 'Importar',
    customFields: 'Campos personalizados',
    search: 'Buscar por nome, telefone ou e-mail',
    optedOut: 'Descadastrados',
    compact: 'Lista compacta',
    colContact: 'Contato',
    colEmail: 'E-mail',
    colTags: 'Etiquetas',
    colCreated: 'Criado em',
    colActions: 'Ações',
    selected: (n: number) => (n === 1 ? '1 selecionado' : `${n} selecionados`),
    clear: 'Limpar',
    deleteSelected: 'Excluir selecionados',
    selectAll: 'Selecionar todos os contatos desta página',
    select: (name: string) => `Selecionar ${name}`,
    open: (name: string) => `Abrir ${name}`,
    more: (name: string) => `Mais ações para ${name}`,
    openConversation: 'Abrir conversa',
    edit: 'Editar',
    delete: 'Excluir',
    unnamed: 'Sem nome',
    anonymized: 'Anonimizado',
    anonymizedTitle: 'Dados pessoais removidos (LGPD)',
    optedOutStatus: 'Descadastrado',
    optedOutTitle: 'Pediu para não receber mensagens',
    loading: 'Carregando contatos…',
    emptyAll: 'Nenhum contato ainda.',
    emptySearch: 'Nenhum contato encontrado.',
    emptyOptedOut: 'Nenhum contato descadastrado.',
    addFirst: 'Adicionar o primeiro contato',
    range: (from: number, to: number, total: number) => `${from}–${to} de ${total}`,
    page: (p: number, total: number) => `Página ${p} de ${total}`,
    pagination: 'Paginação',
    prev: 'Página anterior',
    next: 'Próxima página',
  },
  'en-US': {
    title: 'Contacts',
    newContact: 'New contact',
    import: 'Import',
    customFields: 'Custom fields',
    search: 'Search by name, phone or email',
    optedOut: 'Opted out',
    compact: 'Compact list',
    colContact: 'Contact',
    colEmail: 'Email',
    colTags: 'Tags',
    colCreated: 'Created',
    colActions: 'Actions',
    selected: (n: number) => `${n} selected`,
    clear: 'Clear',
    deleteSelected: 'Delete selected',
    selectAll: 'Select all contacts on this page',
    select: (name: string) => `Select ${name}`,
    open: (name: string) => `Open ${name}`,
    more: (name: string) => `More actions for ${name}`,
    openConversation: 'Open conversation',
    edit: 'Edit',
    delete: 'Delete',
    unnamed: 'Unnamed',
    anonymized: 'Anonymized',
    anonymizedTitle: 'Personal data removed (LGPD)',
    optedOutStatus: 'Opted out',
    optedOutTitle: 'Asked to stop receiving messages',
    loading: 'Loading contacts…',
    emptyAll: 'No contacts yet.',
    emptySearch: 'No contacts match your search.',
    emptyOptedOut: 'No opted-out contacts.',
    addFirst: 'Add your first contact',
    range: (from: number, to: number, total: number) => `${from}–${to} of ${total}`,
    page: (p: number, total: number) => `Page ${p} of ${total}`,
    pagination: 'Pagination',
    prev: 'Previous page',
    next: 'Next page',
  },
} satisfies Record<Language, Record<string, unknown>>;

export type ContactsCopy = (typeof CONTACTS_COPY)['pt-BR'];

export interface ContactListRowProps {
  contact: Contact;
  tags: Tag[];
  selected: boolean;
  compact: boolean;
  createdLabel: string;
  copy: ContactsCopy;
  onToggleSelect: () => void;
  onOpen: () => void;
  onOpenConversation: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

const quickBtn =
  'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

/**
 * One contact in the list. The quick bar (open conversation, edit) shows on
 * hover / focus-within only and is hidden from the a11y tree: the "…" menu
 * holds the same actions for keyboard, touch and screen readers.
 */
export function ContactListRow({
  contact,
  tags,
  selected,
  compact,
  createdLabel,
  copy,
  onToggleSelect,
  onOpen,
  onOpenConversation,
  onEdit,
  onDelete,
}: ContactListRowProps) {
  const name = contact.name || contact.phone;
  const meta = contactMetaLine(contact);
  const anonymized = !!contact.anonymized_at;
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
        className={cn(
          'w-10 pl-3 pr-1 align-middle',
          cell,
          selected && 'shadow-[inset_3px_0_0_var(--primary)]',
        )}
      >
        <Checkbox
          checked={selected}
          onCheckedChange={onToggleSelect}
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
          <ContactAvatar
            src={contact.avatar_url}
            name={contact.name || ''}
            className={compact ? 'size-7 text-xs' : 'size-9 text-sm'}
          />
          <span
            className={cn(
              'flex min-w-0 flex-1',
              compact ? 'flex-row items-baseline gap-2' : 'flex-col',
            )}
          >
            <span className={cn('flex min-w-0 items-center gap-2', compact && 'max-w-full shrink-0')}>
              <span
                className={cn(
                  'truncate text-sm font-medium text-foreground',
                  !contact.name && 'font-normal italic text-muted-foreground',
                )}
              >
                {contact.name || copy.unnamed}
              </span>
              {anonymized ? (
                <span
                  title={copy.anonymizedTitle}
                  className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
                >
                  <ShieldCheck className="size-3" aria-hidden />
                  {copy.anonymized}
                </span>
              ) : contact.opted_out_at ? (
                <span
                  title={copy.optedOutTitle}
                  className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
                >
                  <span className="size-1.5 rounded-full bg-red-500" aria-hidden />
                  {copy.optedOutStatus}
                </span>
              ) : null}
            </span>
            {meta && (
              <span className="min-w-0 truncate text-xs tabular-nums text-muted-foreground">{meta}</span>
            )}
          </span>
        </button>
      </td>
      <td className={cn('hidden max-w-56 truncate px-2 align-middle text-sm text-muted-foreground md:table-cell', cell)}>
        {contact.email || '—'}
      </td>
      <td className={cn('hidden px-2 align-middle md:table-cell', cell)}>
        {tags.length === 0 ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <span
            className={cn(
              'flex items-center gap-x-3 gap-y-1 text-xs text-muted-foreground',
              compact ? 'max-w-64 flex-nowrap overflow-hidden whitespace-nowrap' : 'flex-wrap',
            )}
          >
            {tags.slice(0, 3).map((tag) => (
              <span key={tag.id} className="inline-flex items-center gap-1.5">
                <span
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: tag.color }}
                  aria-hidden
                />
                {tag.name}
              </span>
            ))}
            {tags.length > 3 && <span>+{tags.length - 3}</span>}
          </span>
        )}
      </td>
      <td className={cn('hidden whitespace-nowrap px-2 align-middle text-xs text-muted-foreground lg:table-cell', cell)}>
        {createdLabel}
      </td>
      <td onClick={(e) => e.stopPropagation()} className={cn('w-px whitespace-nowrap pl-1 pr-3 align-middle', cell)}>
        <div className="flex items-center justify-end gap-0.5">
          <div
            aria-hidden
            className="hidden items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 group-focus-within/row:opacity-100 motion-reduce:transition-none md:flex"
          >
            <button
              type="button"
              tabIndex={-1}
              title={copy.openConversation}
              onClick={onOpenConversation}
              className={quickBtn}
            >
              <MessageCircle className="size-3.5" />
            </button>
            {!anonymized && (
              <button type="button" tabIndex={-1} title={copy.edit} onClick={onEdit} className={quickBtn}>
                <Pencil className="size-3.5" />
              </button>
            )}
          </div>
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
            <DropdownMenuContent align="end" className="bg-popover border-border">
              <DropdownMenuItem
                onClick={onOpenConversation}
                className="text-popover-foreground focus:bg-muted focus:text-foreground"
              >
                <MessageCircle className="size-4" />
                {copy.openConversation}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={anonymized}
                onClick={() => {
                  if (!anonymized) onEdit();
                }}
                className="text-popover-foreground focus:bg-muted focus:text-foreground"
              >
                <Pencil className="size-4" />
                {copy.edit}
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 className="size-4" />
                {copy.delete}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </td>
    </tr>
  );
}
