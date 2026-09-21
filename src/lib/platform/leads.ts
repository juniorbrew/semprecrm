export const LEAD_STATUSES = [
  'novo',
  'em_contato',
  'convertido',
  'descartado',
] as const;
export const LEAD_KINDS = ['contato', 'cadastro'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export type LeadKind = (typeof LEAD_KINDS)[number];

/** Public projection: worker state and source identifiers stay server-side. */
export interface PlatformLead {
  id: string;
  kind: LeadKind;
  status: LeadStatus;
  name: string;
  email: string;
  company: string | null;
  created_at: string;
  updated_at: string;
}

export interface LeadList {
  leads: PlatformLead[];
  total: number;
  new_count: number;
  limit: number;
  offset: number;
}

export function isLeadStatus(value: unknown): value is LeadStatus {
  return (
    typeof value === 'string' && LEAD_STATUSES.includes(value as LeadStatus)
  );
}

export function parseLeadQuery(params: URLSearchParams) {
  const integer = (name: string, fallback: number, max: number) => {
    const value = params.get(name);
    if (value === null) return fallback;
    if (!/^\d+$/.test(value))
      throw new Error('Parâmetro de paginação inválido.');
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n > max || (name === 'limit' && n === 0)) {
      throw new Error('Parâmetro de paginação inválido.');
    }
    return n;
  };
  const status = params.get('status') || null;
  const kind = params.get('kind') || null;
  const search = (params.get('search') ?? '').trim();
  if (status && !isLeadStatus(status)) throw new Error('Status inválido.');
  if (kind && !LEAD_KINDS.includes(kind as LeadKind))
    throw new Error('Tipo inválido.');
  if (search.length > 200)
    throw new Error('Busca deve ter no máximo 200 caracteres.');
  return {
    p_limit: integer('limit', 25, 100),
    p_offset: integer('offset', 0, 1_000_000),
    p_status: status,
    p_kind: kind,
    p_search: search,
  };
}
