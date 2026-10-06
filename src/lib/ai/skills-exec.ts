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
//     'skipped', never created.
// ============================================================

import type { AgentAction } from './skills';

export type ActionStatus = 'ok' | 'skipped' | 'error';

export type MoveDealResult = 'moved' | 'same' | 'no_deal' | 'no_stage';

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
}

export interface ActionResult {
  seq: number;
  skill: AgentAction['skill'];
  status: ActionStatus;
  detail: string;
}

const MOVE_DETAIL: Record<MoveDealResult, { status: ActionStatus; detail: string }> = {
  moved: { status: 'ok', detail: 'Negócio movido de etapa' },
  same: { status: 'skipped', detail: 'O negócio já estava nessa etapa' },
  no_deal: { status: 'skipped', detail: 'O contato não tem negócio aberto' },
  no_stage: { status: 'skipped', detail: 'Etapa não encontrada no funil do negócio' },
};

async function perform(action: AgentAction, gw: SkillGateway): Promise<{ status: ActionStatus; detail: string }> {
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
  }
}

export async function executeActions(actions: readonly AgentAction[], gw: SkillGateway): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  for (let seq = 0; seq < actions.length; seq++) {
    const action = actions[seq];
    let outcome: { status: ActionStatus; detail: string };
    try {
      if (!(await gw.claim(seq, action))) continue; // already ran for this job
      try {
        outcome = await perform(action, gw);
      } catch (err) {
        outcome = { status: 'error', detail: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
      }
      await gw.finish(seq, outcome.status, outcome.detail.slice(0, 300));
    } catch (err) {
      // The ledger itself failed: log and move on, the reply must go out.
      console.error('[ai/skills] could not record action:', action.skill, err instanceof Error ? err.message : err);
      continue;
    }
    results.push({ seq, skill: action.skill, ...outcome });
  }
  return results;
}
