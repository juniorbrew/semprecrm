// ============================================================
// Agent skills (migration 080) — the actions an AI agent may take
// besides answering. Pure: the catalogue, the prompt block and the
// strict parser of what the model asks for. Nothing here touches the
// database; ./skills-exec.ts runs the validated actions.
//
// Safety model: the model only SUGGESTS actions inside its JSON reply.
// The server drops every action whose skill is not turned on for the
// agent, caps the count, validates every field and resolves names
// (tags, stages) against what already exists — it never creates them.
// Only reversible actions exist; irreversible ones are not built.
// ============================================================

export const SKILL_IDS = ['internal_note', 'add_tag', 'create_task', 'move_deal_stage'] as const;
export type SkillId = (typeof SKILL_IDS)[number];

export type SkillGroup = 'organize' | 'sell';

export interface SkillInfo {
  id: SkillId;
  group: SkillGroup;
  /** pt-BR, rendered through t(). */
  label: string;
  description: string;
}

export const SKILLS: readonly SkillInfo[] = [
  {
    id: 'internal_note',
    group: 'organize',
    label: 'Registrar nota interna',
    description: 'Deixa uma nota no contato, visível só para a equipe, com o que ficou combinado.',
  },
  {
    id: 'add_tag',
    group: 'organize',
    label: 'Aplicar etiqueta',
    description: 'Marca o contato com uma etiqueta que já existe, como "Interessado".',
  },
  {
    id: 'create_task',
    group: 'organize',
    label: 'Criar tarefa',
    description: 'Cria uma tarefa para a equipe, com prazo, ligada ao contato e à conversa.',
  },
  {
    id: 'move_deal_stage',
    group: 'sell',
    label: 'Mover o negócio de etapa',
    description: 'Avança o negócio aberto do contato para outra etapa do mesmo funil.',
  },
];

export const SKILL_GROUPS: readonly { id: SkillGroup; label: string }[] = [
  { id: 'sell', label: 'Vender e mover o funil' },
  { id: 'organize', label: 'Organizar a operação' },
];

export const isSkillId = (v: unknown): v is SkillId => (SKILL_IDS as readonly unknown[]).includes(v);

/** Keeps only known skills, de-duplicated, in catalogue order; null when `v` is not a list of them. */
export function parseSkills(v: unknown): SkillId[] | null {
  if (!Array.isArray(v) || !v.every(isSkillId)) return null;
  return SKILL_IDS.filter((id) => (v as SkillId[]).includes(id));
}

export const SKILL_LIMITS = {
  maxActionsPerReply: 3,
  noteMaxChars: 500,
  tagMaxChars: 80,
  stageMaxChars: 80,
  taskTitleMaxChars: 120,
  taskDescriptionMaxChars: 500,
  dueMaxHours: 720,
  /** Names offered to the model (tags / stages) — a prompt-size bound. */
  promptNamesMax: 60,
} as const;

export type AgentAction =
  | { skill: 'internal_note'; text: string }
  | { skill: 'add_tag'; tag: string }
  | { skill: 'create_task'; title: string; description: string | null; dueInHours: number | null }
  | { skill: 'move_deal_stage'; stage: string };

// Control characters out, whitespace collapsed (keeps newlines out of one-line fields).
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = clean(v);
  return t ? t.slice(0, max) : null;
}

/**
 * What the model asked for → the actions the server will run. Anything
 * not turned on for the agent, malformed or repeated is dropped; at most
 * SKILL_LIMITS.maxActionsPerReply survive, in the model's order.
 */
export function parseActions(raw: unknown, enabled: readonly SkillId[]): AgentAction[] {
  if (!Array.isArray(raw) || enabled.length === 0) return [];
  const allowed = new Set<string>(enabled);
  const out: AgentAction[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= SKILL_LIMITS.maxActionsPerReply) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const a = item as Record<string, unknown>;
    if (typeof a.skill !== 'string' || !allowed.has(a.skill)) continue;
    let action: AgentAction | null = null;
    switch (a.skill) {
      case 'internal_note': {
        const t = text(a.text, SKILL_LIMITS.noteMaxChars);
        if (t) action = { skill: 'internal_note', text: t };
        break;
      }
      case 'add_tag': {
        const t = text(a.tag, SKILL_LIMITS.tagMaxChars);
        if (t) action = { skill: 'add_tag', tag: t };
        break;
      }
      case 'create_task': {
        const title = text(a.title, SKILL_LIMITS.taskTitleMaxChars);
        if (!title) break;
        const due = typeof a.due_in_hours === 'number' && Number.isFinite(a.due_in_hours) ? a.due_in_hours : null;
        action = {
          skill: 'create_task',
          title,
          description: text(a.description, SKILL_LIMITS.taskDescriptionMaxChars),
          dueInHours: due !== null && due > 0 && due <= SKILL_LIMITS.dueMaxHours ? due : null,
        };
        break;
      }
      case 'move_deal_stage': {
        const t = text(a.stage, SKILL_LIMITS.stageMaxChars);
        if (t) action = { skill: 'move_deal_stage', stage: t };
        break;
      }
    }
    if (!action) continue;
    const key = JSON.stringify(action);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(action);
  }
  return out;
}

export interface SkillsPromptInput {
  enabled: readonly SkillId[];
  /** Names of the account's existing tags (only used when add_tag is on). */
  tags: readonly string[];
  /** Stage names of the contact's open deal's pipeline (only used when move_deal_stage is on). */
  stages: readonly string[];
}

const names = (list: readonly string[]) =>
  JSON.stringify(list.map((n) => clean(n).slice(0, 80)).filter(Boolean).slice(0, SKILL_LIMITS.promptNamesMax));

/**
 * Extra system-prompt lines for an agent with skills (empty when none is
 * usable). Names listed here are DATA from the account, not instructions.
 */
export function skillsPromptLines(input: SkillsPromptInput): string[] {
  const shapes: string[] = [];
  const rules: string[] = [];
  for (const id of input.enabled) {
    if (id === 'internal_note') {
      shapes.push('{"skill": "internal_note", "text": "nota curta para a equipe"}');
    } else if (id === 'add_tag' && input.tags.length > 0) {
      shapes.push('{"skill": "add_tag", "tag": "nome exato de uma etiqueta existente"}');
      rules.push(`Etiquetas existentes (dados): ${names(input.tags)}. Use só um destes nomes, exatamente.`);
    } else if (id === 'create_task') {
      shapes.push('{"skill": "create_task", "title": "o que a equipe deve fazer", "description": "contexto curto ou null", "due_in_hours": 24}');
    } else if (id === 'move_deal_stage' && input.stages.length > 0) {
      shapes.push('{"skill": "move_deal_stage", "stage": "nome exato de uma etapa do funil"}');
      rules.push(`Etapas do funil do negócio deste contato (dados): ${names(input.stages)}. Use só um destes nomes, exatamente.`);
    }
  }
  if (shapes.length === 0) return [];
  return [
    '',
    `Ações opcionais: além de "reply", você pode incluir no objeto JSON a chave "actions", uma lista com no máximo ${SKILL_LIMITS.maxActionsPerReply} ações, somente destes formatos:`,
    ...shapes.map((s) => `- ${s}`),
    ...rules,
    'Use uma ação só quando a conversa mostrar claramente que ela é necessária; na dúvida, não inclua "actions". Nunca invente nomes. Não mencione essas ações ao cliente e não peça a ele para executá-las.',
  ];
}
