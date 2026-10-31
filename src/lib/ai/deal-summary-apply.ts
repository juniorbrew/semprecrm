// ============================================================
// "Aplicar" of "Resumir com IA" — server side.
//
// Nothing the browser (or the model) says is trusted: the deal is
// re-read for THIS account + THIS conversation's contact and must be
// open, every update is re-validated by `normalizeUpdates`, and each
// accepted one goes through the helpers the app already uses for the
// same manual action, with the caller's own RLS client (never service
// role), so the permissions are exactly those of editing by hand:
//
//   stage        moveDealToStage()       src/lib/pipelines/move-deal.ts
//                (UPDATE stage_id + "Negócio movido" event on the
//                 conversation — a manual move does nothing more; no
//                 automation or webhook is tied to a stage change)
//   value/date   validateDealFields()    src/lib/pipelines/deal-fields.ts
//   note         the previous "Resumo da IA" block of deals.notes is
//                REPLACED (everything the user wrote stays), so repeated
//                use never grows past the 2000-char limit
//   task         createTask()            src/lib/tasks/mutations.ts
//
// The card sends what it SHOWED (`expected`: stage, value, close date).
// If the deal changed since the summary was generated, the affected
// items answer 'stale' instead of overwriting newer work. The deal
// columns UPDATE also matches the updated_at read at the start and
// status = 'open', so a concurrent edit or a won/lost deal is 'stale'.
//
// Items are independent: one failing never blocks or undoes another;
// the result says, per item, what happened.
// ============================================================

import type { AccountContext } from '@/lib/auth/account';
import { getEntitlements } from '@/lib/auth/account';
import { validateDealFields, type DealFieldDraft, type DealFieldKey } from '@/lib/pipelines/deal-fields';
import { moveDealToStage } from '@/lib/pipelines/move-deal';
import { createTask, listTaskStatuses } from '@/lib/tasks';
import type { PipelineStage } from '@/types';
import {
  dueAtFromDate,
  normalizeUpdates,
  todayInSaoPaulo,
  type DealUpdateKey,
  type RawDealUpdates,
} from './deal-summary';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ApplyItemStatus =
  | 'applied'
  | 'invalid'
  | 'failed'
  | 'too_long'
  | 'not_in_plan'
  | 'stale'
  | 'already'
  | 'duplicate';
export type ApplyResults = Partial<Record<DealUpdateKey, ApplyItemStatus>>;

export interface DealRow {
  id: string;
  title: string;
  value: number;
  expected_close_date: string | null;
  notes: string | null;
  stage_id: string;
  pipeline_id: string;
  contact_id: string;
  status: string;
  updated_at: string | null;
}

/** What the card showed when the summary was generated. */
export interface ExpectedDeal {
  stage_id?: unknown;
  value?: unknown;
  expected_close_date?: unknown;
}

/** The request body, loosely typed on purpose: it is validated below. */
export function rawUpdatesFromBody(body: unknown): { dealId: string | null; raw: RawDealUpdates; expected: ExpectedDeal } {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const t = typeof b.task === 'object' && b.task !== null ? (b.task as Record<string, unknown>) : b.task;
  const e = typeof b.expected === 'object' && b.expected !== null ? (b.expected as Record<string, unknown>) : {};
  return {
    dealId: typeof b.deal_id === 'string' && UUID_RE.test(b.deal_id) ? b.deal_id : null,
    raw: {
      stageId: b.stage_id,
      value: b.value,
      closeDate: b.expected_close_date,
      task:
        typeof t === 'object' && t !== null
          ? { title: (t as Record<string, unknown>).title, dueDate: (t as Record<string, unknown>).due_date }
          : t,
      note: b.note,
    },
    expected: {
      stage_id: e.stage_id,
      value: e.value,
      ...('expected_close_date' in e ? { expected_close_date: e.expected_close_date } : {}),
    },
  };
}

const NOTE_MARK = /^Resumo da IA — \d{2}\/\d{2}\/\d{4}$/;

/**
 * Notes with the previous "Resumo da IA — dd/mm/aaaa" block (header + its
 * lines, up to the next blank line) replaced by this one; every other
 * line the user wrote stays as it was.
 */
export function replaceSummaryNote(existing: string | null, note: string, today: string): string {
  const lines = (existing ?? '').split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (NOTE_MARK.test(lines[i].trim())) {
      while (i + 1 < lines.length && lines[i + 1].trim() !== '') i++;
      // drop the blank separator that followed the old block
      if (i + 1 < lines.length && (kept.length === 0 || kept[kept.length - 1].trim() === '')) i++;
      continue;
    }
    kept.push(lines[i]);
  }
  const rest = kept.join('\n').trim();
  const [y, m, d] = today.split('-');
  const block = `Resumo da IA — ${d}/${m}/${y}\n${note}`;
  return rest ? `${rest}\n\n${block}` : block;
}

/** Lowercase, no accents, punctuation collapsed — "Enviar proposta!" == "enviar  proposta". */
export function normalizeTitle(t: string): string {
  return t
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** One field through validateDealFields (so the panel's rules are the only rules). */
function validField(key: DealFieldKey, draft: DealFieldDraft): boolean {
  return validateDealFields(draft, { [key]: true }).ok;
}

/** The deal of the conversation's contact in this account, any status (the route tells closed from foreign). */
export async function loadDeal(ctx: AccountContext, contactId: string, dealId: string): Promise<DealRow | null> {
  const { data, error } = await ctx.supabase
    .from('deals')
    .select('id, title, value, expected_close_date, notes, stage_id, pipeline_id, contact_id, status, updated_at')
    .eq('id', dealId)
    .eq('account_id', ctx.accountId)
    .eq('contact_id', contactId)
    .maybeSingle();
  if (error) throw new Error(`deal read failed: ${error.message}`);
  return (data as DealRow | null) ?? null;
}

export async function loadPipelineStages(ctx: AccountContext, pipelineId: string): Promise<PipelineStage[]> {
  const { data, error } = await ctx.supabase
    .from('pipeline_stages')
    .select('*')
    .eq('pipeline_id', pipelineId)
    .order('position');
  if (error) throw new Error(`stages read failed: ${error.message}`);
  return (data ?? []) as PipelineStage[];
}

export async function applyDealUpdates(
  ctx: AccountContext,
  input: {
    conversationId: string;
    contactId: string;
    deal: DealRow;
    raw: RawDealUpdates;
    expected: ExpectedDeal;
    now?: Date;
  },
): Promise<ApplyResults> {
  const { deal, expected } = input;
  const today = todayInSaoPaulo(input.now ?? new Date());
  const stages = await loadPipelineStages(ctx, deal.pipeline_id);
  const { updates, rejected } = normalizeUpdates(input.raw, { today, stageIds: stages.map((s) => s.id) });
  const results: ApplyResults = {};
  for (const k of rejected) results[k] = 'invalid';

  // Plan modules: Pipelines for the deal itself, Tasks for the task.
  const ent = await getEntitlements(ctx);
  const dealAllowed = ent.modules.pipelines === true;
  const tasksAllowed = ent.modules.tasks === true;

  // Did the deal change since the card showed it?
  const currentDate = deal.expected_close_date?.slice(0, 10) ?? null;
  const staleStage = expected.stage_id !== deal.stage_id;
  const staleValue = typeof expected.value !== 'number' || expected.value !== Number(deal.value);
  const staleDate = !('expected_close_date' in expected) || (expected.expected_close_date ?? null) !== currentDate;

  // ---- deal columns (value, close date, note): one guarded UPDATE ----
  const patch: Record<string, unknown> = {};
  const columnKeys: DealUpdateKey[] = [];
  const addColumn = (key: DealUpdateKey, ok: boolean, stale: boolean, apply: () => void) => {
    if (!dealAllowed) results[key] = 'not_in_plan';
    else if (stale) results[key] = 'stale';
    else if (!ok) results[key] = key === 'note' ? 'too_long' : 'invalid';
    else {
      apply();
      columnKeys.push(key);
    }
  };
  if (updates.value !== undefined) {
    const value = updates.value;
    addColumn('value', validField('value', { value: String(value), expected_close_date: '', notes: '' }), staleValue, () => {
      patch.value = value;
    });
  }
  if (updates.closeDate !== undefined) {
    const date = updates.closeDate;
    addColumn('closeDate', validField('expected_close_date', { value: '', expected_close_date: date, notes: '' }), staleDate, () => {
      patch.expected_close_date = date;
    });
  }
  if (updates.note !== undefined) {
    const notes = replaceSummaryNote(deal.notes, updates.note, today);
    addColumn('note', validField('notes', { value: '', expected_close_date: '', notes }), false, () => {
      patch.notes = notes;
    });
  }
  if (columnKeys.length) {
    try {
      const { data, error } = await ctx.supabase
        .from('deals')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', deal.id)
        .eq('account_id', ctx.accountId)
        .eq('status', 'open')
        .eq('updated_at', deal.updated_at)
        .select('id');
      if (error) throw new Error(error.message);
      // 0 rows = somebody edited or closed the deal after we read it.
      const status: ApplyItemStatus = data && data.length > 0 ? 'applied' : 'stale';
      for (const k of columnKeys) results[k] = status;
    } catch (err) {
      console.error('[ai/deal-summary] deal update failed:', err instanceof Error ? err.message : err);
      for (const k of columnKeys) results[k] = 'failed';
    }
  }

  // ---- stage: the same helper as the panel's stage select ----------
  if (updates.stageId !== undefined) {
    if (!dealAllowed) results.stageId = 'not_in_plan';
    else if (updates.stageId === deal.stage_id) results.stageId = 'already';
    else if (staleStage) results.stageId = 'stale';
    else {
      try {
        await moveDealToStage(ctx.supabase, {
          deal,
          toStageId: updates.stageId,
          stages,
          accountId: ctx.accountId,
          conversationId: input.conversationId,
          actorId: ctx.userId,
        });
        results.stageId = 'applied';
      } catch (err) {
        console.error('[ai/deal-summary] stage move failed:', err instanceof Error ? err.message : err);
        results.stageId = 'failed';
      }
    }
  }

  // ---- task: the same helper as the Tasks module -------------------
  if (updates.task !== undefined) {
    if (!tasksAllowed) results.task = 'not_in_plan';
    else {
      try {
        // Same open task (same deal, same normalized title) already there: don't pile up copies.
        const { data: existing, error: dupErr } = await ctx.supabase
          .from('tasks')
          .select('title, completed_at')
          .eq('account_id', ctx.accountId)
          .eq('deal_id', deal.id);
        if (dupErr) throw new Error(dupErr.message);
        const wanted = normalizeTitle(updates.task.title);
        const dup = ((existing ?? []) as { title: string; completed_at: string | null }[]).some(
          (t) => !t.completed_at && normalizeTitle(t.title) === wanted,
        );
        if (dup) results.task = 'duplicate';
        else {
          const statuses = await listTaskStatuses(ctx.supabase, ctx.accountId);
          await createTask(
            ctx.supabase,
            { accountId: ctx.accountId, userId: ctx.userId, statuses },
            {
              title: updates.task.title,
              due_at: updates.task.dueDate ? dueAtFromDate(updates.task.dueDate) : null,
              contact_id: input.contactId,
              conversation_id: input.conversationId,
              deal_id: deal.id,
              assignee_user_id: ctx.userId,
            },
          );
          results.task = 'applied';
        }
      } catch (err) {
        console.error('[ai/deal-summary] task create failed:', err instanceof Error ? err.message : err);
        results.task = 'failed';
      }
    }
  }
  return results;
}
