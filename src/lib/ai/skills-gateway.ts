// ============================================================
// The real SkillGateway: service-role Supabase, strictly scoped to one
// account / contact / conversation. Server only.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { accountHasModule } from '@/lib/plans-server';
import { createTask, dueInHours, listTaskStatuses } from '@/lib/tasks';

import { SKILL_LIMITS, type AgentAction } from './skills';
import type { ActionStatus, MoveDealResult, SkillGateway } from './skills-exec';

export interface SkillScope {
  accountId: string;
  contactId: string;
  conversationId: string;
  agentId: string | null;
  jobId: string;
  /** Conversation owner: contact_notes.user_id is NOT NULL, so notes are written under it, prefixed "[IA]". */
  ownerUserId: string | null;
}

type Row = Record<string, unknown>;

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim();

function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T | null {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

/** The contact's most recently updated open deal, or null. */
async function openDeal(db: SupabaseClient, scope: SkillScope): Promise<{ id: string; pipeline_id: string; stage_id: string } | null> {
  const res = await db
    .from('deals')
    .select('id, pipeline_id, stage_id')
    .eq('account_id', scope.accountId)
    .eq('contact_id', scope.contactId)
    .eq('status', 'open')
    .order('updated_at', { ascending: false })
    .limit(1);
  const rows = must(res, 'deal read') as { id: string; pipeline_id: string; stage_id: string }[] | null;
  return rows?.[0] ?? null;
}

async function stagesOf(db: SupabaseClient, pipelineId: string): Promise<{ id: string; name: string }[]> {
  const res = await db.from('pipeline_stages').select('id, name').eq('pipeline_id', pipelineId).order('position');
  return (must(res, 'stages read') as { id: string; name: string }[] | null) ?? [];
}

/** What the prompt may offer the model: existing tag names and the open deal's stage names. */
export async function loadSkillContext(
  db: SupabaseClient,
  scope: Pick<SkillScope, 'accountId' | 'contactId'>,
  want: { tags: boolean; stages: boolean },
): Promise<{ tags: string[]; stages: string[] }> {
  const full = scope as SkillScope;
  const [tags, stages] = await Promise.all([
    want.tags
      ? db.from('tags').select('name').eq('account_id', scope.accountId).order('name').limit(SKILL_LIMITS.promptNamesMax)
      : Promise.resolve(null),
    want.stages
      ? openDeal(db, full).then((deal) => (deal ? stagesOf(db, deal.pipeline_id) : []))
      : Promise.resolve([]),
  ]);
  return {
    tags: tags ? ((must(tags, 'tags read') as { name: string }[] | null) ?? []).map((t) => t.name) : [],
    stages: stages.map((s) => s.name),
  };
}

export function supabaseSkillGateway(db: SupabaseClient, scope: SkillScope): SkillGateway {
  return {
    async claim(seq: number, action: AgentAction) {
      const { skill, ...params } = action;
      const { error } = await db.from('ai_actions').insert({
        account_id: scope.accountId,
        conversation_id: scope.conversationId,
        contact_id: scope.contactId,
        agent_id: scope.agentId,
        job_id: scope.jobId,
        seq,
        skill,
        params,
        status: 'running',
      });
      if (!error) return true;
      if (error.code === '23505') return false;
      throw new Error(`ai action claim failed: ${error.message}`);
    },

    async finish(seq: number, status: ActionStatus, detail: string) {
      const { error } = await db
        .from('ai_actions')
        .update({ status, detail })
        .eq('job_id', scope.jobId)
        .eq('seq', seq)
        .eq('account_id', scope.accountId);
      if (error) throw new Error(`ai action finish failed: ${error.message}`);
    },

    async addNote(text: string) {
      if (!scope.ownerUserId) throw new Error('conversation has no owner to attribute the note to');
      const { error } = await db.from('contact_notes').insert({
        account_id: scope.accountId,
        contact_id: scope.contactId,
        user_id: scope.ownerUserId,
        note_text: `[IA] ${text}`,
      });
      if (error) throw new Error(`note insert failed: ${error.message}`);
    },

    async findTag(name: string) {
      const res = await db.from('tags').select('id, name').eq('account_id', scope.accountId).limit(500);
      const want = fold(name);
      const rows = (must(res, 'tags read') as { id: string; name: string }[] | null) ?? [];
      return rows.find((t) => fold(t.name) === want) ?? null;
    },

    async addTag(tagId: string) {
      // contact_tags has no account_id: both the contact (scope) and the tag
      // (findTag, same account) were already resolved inside this account.
      const { error } = await db.from('contact_tags').insert({ contact_id: scope.contactId, tag_id: tagId });
      // 23505: the contact already has the tag — that is the outcome we wanted.
      if (error && error.code !== '23505') throw new Error(`tag apply failed: ${error.message}`);
    },

    async createTask(input) {
      if (!(await accountHasModule(db, scope.accountId, 'tasks'))) throw new Error('tasks module is not enabled for this account');
      const statuses = await listTaskStatuses(db, scope.accountId);
      if (statuses.length === 0) throw new Error('account has no task statuses');
      const task = await createTask(
        db,
        { accountId: scope.accountId, userId: null, statuses },
        {
          title: input.title,
          description: input.description ?? undefined,
          priority: 'normal',
          contact_id: scope.contactId,
          conversation_id: scope.conversationId,
          due_at: (input.dueInHours ? dueInHours(input.dueInHours) : null) ?? undefined,
        },
      );
      return task.id;
    },

    async moveDeal(stageName: string): Promise<MoveDealResult> {
      const deal = await openDeal(db, scope);
      if (!deal) return 'no_deal';
      const want = fold(stageName);
      const stage = (await stagesOf(db, deal.pipeline_id)).find((s) => fold(s.name) === want);
      if (!stage) return 'no_stage';
      if (stage.id === deal.stage_id) return 'same';
      const { error } = await db
        .from('deals')
        .update({ stage_id: stage.id, updated_at: new Date().toISOString() } as Row)
        .eq('id', deal.id)
        .eq('account_id', scope.accountId);
      if (error) throw new Error(`deal move failed: ${error.message}`);
      return 'moved';
    },
  };
}
