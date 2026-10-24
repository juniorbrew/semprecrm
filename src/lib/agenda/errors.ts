// ============================================================
// Agenda errors — typed, with the pt-BR message the UI and the AI show.
// `fromRpcError` maps the SQLSTATEs / messages raised by the 096 RPCs.
// ============================================================

export type AgendaErrorCode =
  | 'validation'
  | 'not_found'
  | 'slot_taken'
  | 'busy'
  | 'outside_hours'
  | 'min_notice'
  | 'max_ahead'
  | 'service_not_offered'
  | 'service_unavailable'
  | 'resource_unavailable'
  | 'contact_not_found'
  | 'not_reschedulable'
  | 'read_only'
  | 'forbidden'
  | 'conflict'
  | 'internal';

const MESSAGES: Record<AgendaErrorCode, string> = {
  validation: 'Dados inválidos.',
  not_found: 'Não encontrado.',
  slot_taken: 'Esse horário acabou de ser ocupado. Escolha outro horário.',
  busy: 'O profissional já tem um compromisso nesse horário.',
  outside_hours: 'Esse horário está fora do atendimento do profissional.',
  min_notice: 'Esse horário está muito próximo. Respeite a antecedência mínima de agendamento.',
  max_ahead: 'Esse horário está além do limite de dias para agendar.',
  service_not_offered: 'Esse profissional não realiza esse serviço.',
  service_unavailable: 'Esse serviço não está disponível.',
  resource_unavailable: 'Esse profissional não está disponível.',
  contact_not_found: 'Contato ou conversa não encontrado.',
  not_reschedulable: 'Esse agendamento já foi encerrado e não pode ser remarcado.',
  read_only: 'A conta está somente leitura. Regularize o plano para agendar.',
  forbidden: 'Você não tem permissão para isso.',
  conflict: 'Já existe um registro com esses dados.',
  internal: 'Não foi possível concluir. Tente novamente.',
};

const STATUS: Record<AgendaErrorCode, number> = {
  validation: 400,
  not_found: 404,
  slot_taken: 409,
  busy: 409,
  outside_hours: 422,
  min_notice: 422,
  max_ahead: 422,
  service_not_offered: 422,
  service_unavailable: 422,
  resource_unavailable: 422,
  contact_not_found: 404,
  not_reschedulable: 409,
  read_only: 402,
  forbidden: 403,
  conflict: 409,
  internal: 500,
};

export class AgendaError extends Error {
  readonly code: AgendaErrorCode;
  readonly status: number;
  constructor(code: AgendaErrorCode, message?: string) {
    super(message ?? MESSAGES[code]);
    this.name = 'AgendaError';
    this.code = code;
    this.status = STATUS[code];
  }
}

export function isAgendaError(err: unknown): err is AgendaError {
  return err instanceof AgendaError;
}

interface PgLikeError {
  code?: string | null;
  message?: string | null;
}

const BY_MESSAGE: Record<string, AgendaErrorCode> = {
  agenda_slot_taken: 'slot_taken',
  agenda_busy: 'busy',
  agenda_service_not_offered: 'service_not_offered',
  agenda_service_unavailable: 'service_unavailable',
  agenda_resource_unavailable: 'resource_unavailable',
  agenda_contact_not_found: 'contact_not_found',
  agenda_not_reschedulable: 'not_reschedulable',
  agenda_appointment_not_found: 'not_found',
  agenda_bad_status: 'validation',
  agenda_resource_user_not_member: 'validation',
};

/** Map a PostgREST / Postgres error from the agenda RPCs or tables. */
export function fromRpcError(error: PgLikeError): AgendaError {
  const message = error.message ?? '';
  const named = Object.keys(BY_MESSAGE).find((k) => message.startsWith(k));
  if (named) return new AgendaError(BY_MESSAGE[named]);
  if (message.startsWith('read_only_account')) return new AgendaError('read_only');
  if (error.code === '23P01') return new AgendaError('slot_taken'); // exclusion_violation
  if (error.code === '23505') return new AgendaError('conflict'); // unique_violation
  if (error.code === '23503') return new AgendaError('conflict'); // foreign_key_violation (in use)
  if (error.code === '42501') return new AgendaError('forbidden');
  if (error.code === '23514' || error.code === '22P02') return new AgendaError('validation');
  console.error('[agenda] unexpected database error:', error.code, message);
  return new AgendaError('internal');
}

/** Rule reasons from `explainStart` -> error. */
export function fromUnavailableReason(reason: 'min_notice' | 'max_ahead' | 'outside_hours' | 'busy'): AgendaError {
  return new AgendaError(reason);
}
