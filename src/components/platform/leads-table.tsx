'use client';

import { useRef, useState, type FormEvent } from 'react';
import { Loader2, Search, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  LEAD_STATUSES,
  type LeadList,
  type LeadStatus,
  type PlatformLead,
} from '@/lib/platform/leads';
import { useLeadCount } from './platform-navigation';

const labels: Record<LeadStatus, string> = {
  novo: 'Novo',
  em_contato: 'Em contato',
  convertido: 'Convertido',
  descartado: 'Descartado',
};
const statusColors: Record<LeadStatus, string> = {
  novo: 'text-blue-700 dark:text-blue-300 bg-blue-500/10',
  em_contato: 'text-amber-700 dark:text-amber-300 bg-amber-500/10',
  convertido: 'text-emerald-700 dark:text-emerald-300 bg-emerald-500/10',
  descartado: 'text-muted-foreground bg-muted',
};
const selectClass =
  'h-9 min-w-0 rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:opacity-60';
const pageSize = 25;
type Filters = { search: string; status: string; kind: string };
const emptyFilters: Filters = { search: '', status: '', kind: '' };

function LeadStatusSelect({
  lead,
  disabled,
  onChange,
}: {
  lead: PlatformLead;
  disabled: boolean;
  onChange: (status: LeadStatus) => void;
}) {
  return (
    <select
      aria-label={`Status de ${lead.name}`}
      value={lead.status}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as LeadStatus)}
      className={`${selectClass} w-full font-medium ${statusColors[lead.status]}`}
    >
      {LEAD_STATUSES.map((status) => (
        <option key={status} value={status}>
          {labels[status]}
        </option>
      ))}
    </select>
  );
}

function leadDate(value: string) {
  return new Date(value).toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
  });
}

export function PlatformLeadsTable({
  initialData,
}: {
  initialData: LeadList | null;
}) {
  const [data, setData] = useState(initialData);
  const [draft, setDraft] = useState(emptyFilters);
  const [filters, setFilters] = useState(emptyFilters);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const busy = useRef(false);
  const [error, setError] = useState(
    initialData ? '' : 'Não foi possível carregar os leads.'
  );
  const [feedback, setFeedback] = useState('');
  const { setNewCount } = useLeadCount();

  async function load(nextFilters: Filters, nextOffset: number) {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        limit: String(pageSize),
        offset: String(nextOffset),
        ...nextFilters,
      });
      const response = await fetch(`/api/platform/leads?${params}`, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('load');
      const result: LeadList = await response.json();
      setData(result);
      setFilters(nextFilters);
      setOffset(nextOffset);
      setNewCount(result.new_count);
    } catch {
      setError('Não foi possível atualizar a lista. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  async function requestPage(nextFilters: Filters, nextOffset: number) {
    if (busy.current) return;
    busy.current = true;
    setFeedback('');
    try {
      await load(nextFilters, nextOffset);
    } finally {
      busy.current = false;
    }
  }

  function search(event: FormEvent) {
    event.preventDefault();
    void requestPage({ ...draft, search: draft.search.trim() }, 0);
  }

  async function updateStatus(lead: PlatformLead, status: LeadStatus) {
    if (busy.current || status === lead.status) return;
    busy.current = true;
    setSaving(lead.id);
    setFeedback('');
    setError('');
    try {
      const response = await fetch(
        `/api/platform/leads/${encodeURIComponent(lead.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        }
      );
      if (!response.ok) throw new Error('update');
      const { lead: updated }: { lead: PlatformLead } = await response.json();
      if (data) {
        const newCount = Math.max(
          0,
          data.new_count +
            Number(updated.status === 'novo') -
            Number(lead.status === 'novo')
        );
        setData({
          ...data,
          new_count: newCount,
          leads: data.leads.map((row) => (row.id === lead.id ? updated : row)),
        });
        setNewCount(newCount);
      }
      setFeedback('Status atualizado.');
      // A status filter can remove the row: fetch a full first page to preserve totals and fill gaps.
      if (filters.status) await load(filters, 0);
    } catch {
      setError(
        'Não foi possível alterar o status. O valor anterior foi mantido; tente novamente.'
      );
    } finally {
      setSaving(null);
      busy.current = false;
    }
  }

  const disabled = loading || saving !== null;
  const leads = data?.leads ?? [];
  const total = data?.total ?? 0;
  return (
    <section aria-labelledby="leads-title">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 id="leads-title" className="text-2xl font-bold tracking-tight">
            Leads
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Acompanhe contatos e novas contas trial.
          </p>
        </div>
        {data && (
          <span className="bg-primary/10 text-primary shrink-0 rounded-full px-3 py-1 text-sm font-medium">
            {data.new_count} novos
          </span>
        )}
      </div>
      <form
        onSubmit={search}
        className="border-border bg-card mb-5 grid gap-3 rounded-xl border p-4 sm:grid-cols-2 lg:grid-cols-[1fr_170px_170px_auto]"
      >
        <div>
          <label
            htmlFor="lead-search"
            className="text-muted-foreground mb-1.5 block text-xs font-medium"
          >
            Buscar lead
          </label>
          <div className="relative">
            <Search
              aria-hidden
              className="text-muted-foreground absolute top-2.5 left-3 size-4"
            />
            <Input
              id="lead-search"
              placeholder="Nome, e-mail ou empresa"
              maxLength={200}
              value={draft.search}
              disabled={disabled}
              onChange={(event) =>
                setDraft({ ...draft, search: event.target.value })
              }
              className="h-9 pl-9"
            />
          </div>
        </div>
        <div>
          <label
            htmlFor="lead-status"
            className="text-muted-foreground mb-1.5 block text-xs font-medium"
          >
            Status
          </label>
          <select
            id="lead-status"
            className={`${selectClass} w-full`}
            value={draft.status}
            disabled={disabled}
            onChange={(event) =>
              setDraft({ ...draft, status: event.target.value })
            }
          >
            <option value="">Todos os status</option>
            {LEAD_STATUSES.map((status) => (
              <option key={status} value={status}>
                {labels[status]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            htmlFor="lead-kind"
            className="text-muted-foreground mb-1.5 block text-xs font-medium"
          >
            Tipo
          </label>
          <select
            id="lead-kind"
            className={`${selectClass} w-full`}
            value={draft.kind}
            disabled={disabled}
            onChange={(event) =>
              setDraft({ ...draft, kind: event.target.value })
            }
          >
            <option value="">Todos os tipos</option>
            <option value="contato">Contato</option>
            <option value="cadastro">Cadastro trial</option>
          </select>
        </div>
        <Button type="submit" disabled={disabled} className="self-end">
          {loading && <Loader2 aria-hidden className="size-4 animate-spin" />}
          Buscar
        </Button>
      </form>
      <div aria-live="polite" className="mb-3 text-sm">
        {loading ? 'Carregando leads…' : saving ? 'Salvando status…' : feedback}
      </div>
      {error && (
        <div
          role="alert"
          className="border-destructive/30 bg-destructive/5 mb-4 flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm"
        >
          <p>{error}</p>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => void requestPage(filters, offset)}
          >
            Atualizar lista
          </Button>
        </div>
      )}
      <div
        aria-busy={disabled}
        className="border-border bg-card overflow-hidden rounded-xl border"
      >
        {!leads.length ? (
          <div className="px-4 py-14 text-center">
            <Users
              aria-hidden
              className="text-muted-foreground mx-auto mb-3 size-8"
            />
            <p className="font-medium">
              {data ? 'Nenhum lead encontrado' : 'Lista indisponível'}
            </p>
            <p className="text-muted-foreground mt-1 text-sm">
              {data
                ? 'Novos contatos e cadastros aparecerão aqui. Ajuste os filtros para buscar outros leads.'
                : 'Tente carregar a lista novamente.'}
            </p>
          </div>
        ) : (
          <>
            <table className="hidden w-full table-fixed text-sm md:table">
              <thead className="bg-muted/50 text-muted-foreground text-left text-xs tracking-wide uppercase">
                <tr>
                  {['Tipo', 'Nome', 'E-mail', 'Empresa', 'Status', 'Data'].map(
                    (label) => (
                      <th key={label} className="px-3 py-3">
                        {label}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {leads.map((lead) => (
                  <tr key={lead.id} className="hover:bg-muted/30">
                    <td className="text-muted-foreground px-3 py-4">
                      {lead.kind === 'contato' ? 'Contato' : 'Cadastro trial'}
                    </td>
                    <td
                      className="px-3 py-4 font-medium break-words"
                      data-no-translate
                    >
                      {lead.name}
                    </td>
                    <td className="px-3 py-4 break-all" data-no-translate>
                      {lead.email}
                    </td>
                    <td
                      className="text-muted-foreground px-3 py-4 break-words"
                      data-no-translate
                    >
                      {lead.company || '—'}
                    </td>
                    <td className="px-3 py-4">
                      <LeadStatusSelect
                        lead={lead}
                        disabled={disabled}
                        onChange={(status) => void updateStatus(lead, status)}
                      />
                    </td>
                    <td className="text-muted-foreground px-3 py-4 text-xs">
                      <time dateTime={lead.created_at}>
                        {leadDate(lead.created_at)}
                      </time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="divide-border divide-y md:hidden">
              {leads.map((lead) => (
                <li key={lead.id} className="space-y-3 p-4">
                  <div className="text-muted-foreground flex justify-between gap-3 text-xs">
                    <span>
                      {lead.kind === 'contato' ? 'Contato' : 'Cadastro trial'}
                    </span>
                    <time dateTime={lead.created_at}>
                      {leadDate(lead.created_at)}
                    </time>
                  </div>
                  <div className="space-y-1" data-no-translate>
                    <p className="font-semibold break-words">{lead.name}</p>
                    <p className="text-sm break-all">{lead.email}</p>
                    <p className="text-muted-foreground text-sm break-words">
                      {lead.company || 'Empresa não informada'}
                    </p>
                  </div>
                  <LeadStatusSelect
                    lead={lead}
                    disabled={disabled}
                    onChange={(status) => void updateStatus(lead, status)}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      {data && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
          <p className="text-muted-foreground">
            {total === 0
              ? '0 leads'
              : `${offset + 1}–${Math.min(offset + leads.length, total)} de ${total} leads`}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || offset === 0}
              onClick={() =>
                void requestPage(filters, Math.max(0, offset - pageSize))
              }
            >
              Anterior
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || offset + pageSize >= total}
              onClick={() => void requestPage(filters, offset + pageSize)}
            >
              Próxima
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
