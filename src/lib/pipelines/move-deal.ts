// Move a deal to another stage of its own pipeline from the inbox panel.
//
// Same persistence as the Pipelines board (`handleDealMoved`): a plain
// UPDATE of stage_id + updated_at under the agent+ `deals_update` RLS —
// stages carry no won/lost flag (that is `deals.status`, untouched) and
// no automation trigger fires on a move today, so there is nothing else
// to invoke. On top of it the move is logged on the active conversation
// ("Negócio X movido de A para B", migration 070 event type).

import type { SupabaseClient } from '@supabase/supabase-js';

import { insertConversationEvent } from '@/lib/conversations/events';
import type { Deal, PipelineStage } from '@/types';

export type MoveCheck = 'ok' | 'same-stage' | 'foreign-stage';

/** A deal may only go to a *different* stage of its own pipeline. */
export function checkDealMove(
  deal: Pick<Deal, 'stage_id' | 'pipeline_id'>,
  toStageId: string,
  stages: readonly Pick<PipelineStage, 'id' | 'pipeline_id'>[],
): MoveCheck {
  const target = stages.find((s) => s.id === toStageId);
  if (!target || target.pipeline_id !== deal.pipeline_id) return 'foreign-stage';
  return deal.stage_id === toStageId ? 'same-stage' : 'ok';
}

export interface MoveDealInput {
  deal: Pick<Deal, 'id' | 'title' | 'stage_id' | 'pipeline_id'>;
  toStageId: string;
  /** The deal's pipeline stages (any superset works; ownership is checked). */
  stages: readonly PipelineStage[];
  accountId: string | null;
  conversationId: string | null;
  actorId: string | null;
  actorName?: string;
}

/** Persists the move and logs it; throws when the UPDATE fails. */
export async function moveDealToStage(
  supabase: SupabaseClient,
  input: MoveDealInput,
): Promise<PipelineStage> {
  const check = checkDealMove(input.deal, input.toStageId, input.stages);
  if (check !== 'ok') throw new Error(`deal move rejected: ${check}`);
  const to = input.stages.find((s) => s.id === input.toStageId)!;
  const from = input.stages.find((s) => s.id === input.deal.stage_id);

  const { error } = await supabase
    .from('deals')
    .update({ stage_id: to.id, updated_at: new Date().toISOString() })
    .eq('id', input.deal.id);
  if (error) throw error;

  if (input.conversationId && input.accountId) {
    // Best effort, like every other panel event: the move already stuck.
    await insertConversationEvent(supabase, {
      account_id: input.accountId,
      conversation_id: input.conversationId,
      actor_user_id: input.actorId,
      event_type: 'deal_stage_changed',
      payload: {
        actor_name: input.actorName,
        deal_id: input.deal.id,
        deal_title: input.deal.title,
        from_stage_name: from?.name,
        to_stage_name: to.name,
      },
    });
  }
  return to;
}
