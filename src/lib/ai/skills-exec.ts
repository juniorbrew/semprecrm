// ============================================================
// Runs the actions an agent asked for (see ./skills.ts). The logic is
// here; every database touch goes through a SkillGateway so it is
// testable and so the real one (./skills-gateway.ts) is the only place
// that needs the service role.
//
// Contract:
//   * at-most-once per (job, position): `claim` writes the ai_actions
//     row first and returns false when it already exists (a retried
//     reply job) — that action is skipped, never repeated;
//   * an action that fails is recorded as 'error' and never stops the
//     reply or the other actions;
//   * names are resolved against what exists; a missing tag or stage is
//     'skipped', never created;
//   * book_appointment is the one action the customer hears about: its
//     result carries `customerMessage` (the confirmation, or why it could
//     not be booked), sent by the server after the model's reply — the
//     model never confirms a booking itself.
// ============================================================

import type { AgentAction } from './skills';

export type ActionStatus = 'ok' | 'skipped' | 'error';

export type MoveDealResult = 'moved' | 'same' | 'no_deal' | 'no_stage';

export type BookResult =
  | { ok: true; service: string; professional: string | null; startsAt: string; timezone: string }
  | { ok: false; reason: 'no_service' | 'no_professional' | 'taken' | 'unavailable' | 'limit' };

export interface SkillGateway {
  /** Records the action as running. false = already recorded for this job/position. */
  claim(seq: number, action: AgentAction): Promise<boolean>;
  finish(seq: number, status: ActionStatus, detail: string): Promise<void>;
  addNote(text: string): Promise<void>;
  /** Exact (case/accent-insensitive) match among the account's tags. */
  findTag(name: string): Promise<{ id: string; name: string } | null>;
  addTag(tagId: string): Promise<void>;
  createTask(input: { title: string; description: string | null; dueInHours: number | null }): Promise<string>;
  moveDeal(stageName: string): Promise<MoveDealResult>;
  /** Books through the agenda service (source 'ai', no encaixe). One appointment per job, however often it is asked. */
  book(input: { service: string; date: string; time: string; professional: string | null }): Promise<BookResult>;
}

export interface ActionResult {
  seq: number;
  skill: AgentAction['skill'];
  status: ActionStatus;
  detail: string;
  /** Text the server sends to the customer after the reply (book_appointment only). */
  customerMessage?: string;
}

type Outcome = { status: ActionStatus; detail: string; customerMessage?: string };

const TRY_ANOTHER = 'Me diga outro horário que eu verifico para você.';
export const BOOK_MESSAGES = {
  taken: `Esse horário acabou de ser ocupado. ${TRY_ANOTHER}`,
  unavailable: `Não consegui reservar esse horário. ${TRY_ANOTHER}`,
  failed: 'Não consegui concluir a reserva agora. Alguém da equipe vai confirmar o horário com você.',
  limit: 'Você já tem horários marcados com a gente. Alguém da equipe vai falar com você sobre um novo.',
} as const;

/** "terça-feira, 28/10 às 14:00" in the agenda's timezone. */
export function bookedWhen(startsAt: string, timezone: string): string {
  const at = new Date(startsAt);
  const day = new Intl.DateTimeFormat('pt-BR', { timeZone: timezone, weekday: 'long', day: '2-digit', month: '2-digit' }).format(at);
  const time = new Intl.DateTimeFormat('pt-BR', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  return `${day} às ${time}`;
}

function bookOutcome(r: BookResult): Outcome {
  if (r.ok) {
    const when = bookedWhen(r.startsAt, r.timezone);
    const who = r.professional ? `, com ${r.professional}` : '';
    return {
      status: 'ok',
      detail: `Agendamento criado: ${r.service}, ${when}${who}`,
      customerMessage: `Pronto! Seu horário está reservado: ${r.service}, ${when}${who}.`,
    };
  }
  const detail = {
    no_service: 'Serviço não encontrado na agenda',
    no_professional: 'Profissional não encontrado para esse serviço',
    taken: 'O horário já estava ocupado',
    unavailable: 'Horário fora das regras da agenda',
    limit: 'O contato já tem o máximo de horários futuros que a IA pode marcar',
  }[r.reason];
  const customerMessage = r.reason === 'taken' || r.reason === 'limit' ? BOOK_MESSAGES[r.reason] : BOOK_MESSAGES.unavailable;
  return { status: 'skipped', detail, customerMessage };
}

const MOVE_DETAIL: Record<MoveDealResult, { status: ActionStatus; detail: string }> = {
  moved: { status: 'ok', detail: 'Negócio movido de etapa' },
  same: { status: 'skipped', detail: 'O negócio já estava nessa etapa' },
  no_deal: { status: 'skipped', detail: 'O contato não tem negócio aberto' },
  no_stage: { status: 'skipped', detail: 'Etapa não encontrada no funil do negócio' },
};

async function perform(action: AgentAction, gw: SkillGateway): Promise<Outcome> {
  switch (action.skill) {
    case 'internal_note':
      await gw.addNote(action.text);
      return { status: 'ok', detail: 'Nota registrada' };
    case 'add_tag': {
      const tag = await gw.findTag(action.tag);
      if (!tag) return { status: 'skipped', detail: 'Etiqueta não encontrada' };
      await gw.addTag(tag.id);
      return { status: 'ok', detail: `Etiqueta "${tag.name}" aplicada` };
    }
    case 'create_task': {
      await gw.createTask({ title: action.title, description: action.description, dueInHours: action.dueInHours });
      return { status: 'ok', detail: 'Tarefa criada' };
    }
    case 'move_deal_stage':
      return MOVE_DETAIL[await gw.moveDeal(action.stage)];
    case 'book_appointment':
      return bookOutcome(await gw.book({ service: action.service, date: action.date, time: action.time, professional: action.professional }));
  }
}

async function performSafe(action: AgentAction, gw: SkillGateway): Promise<Outcome> {
  try {
    return await perform(action, gw);
  } catch (err) {
    const outcome: Outcome = { status: 'error', detail: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
    // The reply said "I'll book it": the customer must not be left waiting.
    if (action.skill === 'book_appointment') outcome.customerMessage = BOOK_MESSAGES.failed;
    return outcome;
  }
}

export async function executeActions(actions: readonly AgentAction[], gw: SkillGateway): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  for (let seq = 0; seq < actions.length; seq++) {
    const action = actions[seq];
    let outcome: Outcome | null = null;
    try {
      if (!(await gw.claim(seq, action))) {
        // Already ran for this job. A retried job never stored its reply, so the
        // customer never heard about the booking: ask again with the same
        // idempotency key (the agenda returns the same appointment, never a
        // second one) and confirm it. The ledger keeps the first result.
        if (action.skill === 'book_appointment') results.push({ seq, skill: action.skill, ...(await performSafe(action, gw)) });
        continue;
      }
      outcome = await performSafe(action, gw);
      await gw.finish(seq, outcome.status, outcome.detail.slice(0, 300));
    } catch (err) {
      // The ledger itself failed: log and move on, the reply must go out.
      console.error('[ai/skills] could not record action:', action.skill, err instanceof Error ? err.message : err);
      if (action.skill === 'book_appointment') {
        // Booked but not recorded: the customer still gets the real result.
        results.push(
          outcome
            ? { seq, skill: action.skill, ...outcome }
            : { seq, skill: action.skill, status: 'error', detail: 'ledger failed', customerMessage: BOOK_MESSAGES.failed },
        );
      }
      continue;
    }
    results.push({ seq, skill: action.skill, ...outcome });
  }
  return results;
}
