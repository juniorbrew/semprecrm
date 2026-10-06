import { describe, expect, it } from 'vitest';

import { buildAutoReplyPrompt, parseAutoReplyOutput } from './auto-reply';
import { parseAgentInput } from './agents';
import { parseActions, parseSkills, SKILLS, SKILL_IDS, skillsPromptLines } from './skills';

describe('catalogue', () => {
  it('describes every skill id exactly once', () => {
    expect(SKILLS.map((s) => s.id).sort()).toEqual([...SKILL_IDS].sort());
  });
});

describe('parseSkills', () => {
  it('keeps catalogue order and drops duplicates', () => {
    expect(parseSkills(['move_deal_stage', 'add_tag', 'add_tag'])).toEqual(['add_tag', 'move_deal_stage']);
  });
  it('rejects anything that is not a list of known skills', () => {
    expect(parseSkills(['add_tag', 'close_deal_as_lost'])).toBeNull();
    expect(parseSkills('add_tag')).toBeNull();
    expect(parseSkills(null)).toBeNull();
  });
});

describe('parseAgentInput skills', () => {
  it('accepts a valid list and rejects an unknown skill', () => {
    const ok = parseAgentInput({ skills: ['create_task'] }, true);
    expect(ok.ok && ok.write.skills).toEqual(['create_task']);
    expect(parseAgentInput({ skills: ['delete_everything'] }, true).ok).toBe(false);
  });
});

describe('parseActions', () => {
  const all = [...SKILL_IDS];

  it('drops actions whose skill is not turned on for the agent', () => {
    const out = parseActions(
      [
        { skill: 'add_tag', tag: 'Interessado' },
        { skill: 'create_task', title: 'Ligar' },
      ],
      ['add_tag'],
    );
    expect(out).toEqual([{ skill: 'add_tag', tag: 'Interessado' }]);
  });

  it('does nothing when no skill is on, or the shape is wrong', () => {
    expect(parseActions([{ skill: 'add_tag', tag: 'x' }], [])).toEqual([]);
    expect(parseActions('add_tag', all)).toEqual([]);
    expect(parseActions([null, 3, [], { skill: 'unknown' }, { skill: 'add_tag' }], all)).toEqual([]);
  });

  it('validates fields and bounds the due time', () => {
    const [task] = parseActions([{ skill: 'create_task', title: '  Ligar \n hoje ', description: '', due_in_hours: 99999 }], all);
    expect(task).toEqual({ skill: 'create_task', title: 'Ligar hoje', description: null, dueInHours: null });
    const [ok] = parseActions([{ skill: 'create_task', title: 'Ligar', due_in_hours: 24 }], all);
    expect(ok).toMatchObject({ dueInHours: 24 });
  });

  it('caps at three actions and drops exact repeats', () => {
    const out = parseActions(
      [
        { skill: 'add_tag', tag: 'A' },
        { skill: 'add_tag', tag: 'A' },
        { skill: 'add_tag', tag: 'B' },
        { skill: 'add_tag', tag: 'C' },
        { skill: 'add_tag', tag: 'D' },
      ],
      all,
    );
    expect(out.map((a) => (a.skill === 'add_tag' ? a.tag : ''))).toEqual(['A', 'B', 'C']);
  });
});

describe('skillsPromptLines', () => {
  it('is empty when nothing usable is on (tag skill with no tags)', () => {
    expect(skillsPromptLines({ enabled: ['add_tag'], tags: [], stages: [] })).toEqual([]);
  });

  it('lists only the enabled shapes and the names the model may pick', () => {
    const text = skillsPromptLines({ enabled: ['add_tag', 'internal_note'], tags: ['Interessado'], stages: ['Proposta'] }).join('\n');
    expect(text).toContain('"internal_note"');
    expect(text).toContain('"add_tag"');
    expect(text).toContain('["Interessado"]');
    expect(text).not.toContain('create_task');
    expect(text).not.toContain('Proposta');
  });
});

describe('auto-reply integration', () => {
  const base = { accountName: 'Acme', contactName: 'Ana', instructions: null, messages: [], maxMessages: 3, maxCharsPerMessage: 400 };

  it('leaves the prompt unchanged without skills', () => {
    expect(buildAutoReplyPrompt(base).system).not.toContain('Ações opcionais');
  });

  it('adds the actions block when skills are on', () => {
    const { system } = buildAutoReplyPrompt({ ...base, skills: { enabled: ['internal_note'], tags: [], stages: [] } });
    expect(system).toContain('Ações opcionais');
  });

  it('exposes the raw actions the model wrote, and tolerates their absence', () => {
    const withActions = parseAutoReplyOutput(
      JSON.stringify({ reply: 'Oi', handoff: false, reason: '', actions: [{ skill: 'add_tag', tag: 'X' }] }),
    );
    expect(withActions?.rawActions).toEqual([{ skill: 'add_tag', tag: 'X' }]);
    expect(parseAutoReplyOutput('{"reply":"Oi","handoff":false}')?.rawActions).toEqual([]);
    expect(parseAutoReplyOutput('{"reply":"Oi","handoff":false,"actions":"nope"}')?.rawActions).toEqual([]);
  });
});
