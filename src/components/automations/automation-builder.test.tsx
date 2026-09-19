import { describe, expect, it, vi } from "vitest"
import { renderToString } from "react-dom/server"

import {
  AutomationBuilder,
  fromServerSteps,
  toApiSteps,
  type BuilderInitial,
  type BuilderStep,
} from "./automation-builder"

// The builder is a client component; rendering it to a string exercises
// the document + inspector markup without a DOM. Effects (resource
// loading, media query correction) never run here, which is exactly the
// server snapshot: docked layout, no account resources.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => {
    throw new Error("createClient must only be called from effects")
  },
}))

let n = 0
const step = (
  step_type: BuilderStep["step_type"],
  step_config: Record<string, unknown>,
  branches?: BuilderStep["branches"],
): BuilderStep => ({ cid: `c_${n++}`, step_type, step_config, branches })

function render(initial: Partial<BuilderInitial>): string {
  // React separates adjacent text nodes with `<!-- -->` markers; strip
  // them so "Ação 1" style assertions read like the rendered page.
  return renderToString(
    <AutomationBuilder
      initial={{
        name: "Boas-vindas",
        description: "",
        trigger_type: "first_inbound_message",
        trigger_config: {},
        is_active: false,
        steps: [],
        ...initial,
      }}
    />,
  ).replace(/<!-- -->/g, "")
}

describe("AutomationBuilder (server render)", () => {
  it("shows the trigger inspector by default and an explicit add-action call", () => {
    const html = render({})
    // Right-hand inspector opens on the trigger, not on an empty state.
    expect(html).toContain("Tipo de gatilho")
    expect(html).not.toContain("Nada selecionado")
    // Section headers + explicit affordances.
    expect(html).toContain("Gatilho")
    expect(html).toContain("Condições")
    expect(html).toContain("Adicionar condição")
    expect(html).toContain("Adicionar ação")
    expect(html).toContain("Ainda não há ações. Adicione a primeira.")
  })

  it("renders a one-line summary on every action card", () => {
    const html = render({
      steps: [
        step("send_message", { text: "Olá! Obrigado por entrar em contato.\nJá respondemos." }),
        step("wait", { amount: 2, unit: "hours" }),
        step("add_tag", { tag_id: "tag-uuid" }),
        step("assign_conversation", { mode: "round_robin" }),
      ],
    })
    expect(html).toContain("Olá! Obrigado por entrar em contato. Já respondemos.")
    expect(html).toContain("Aguardar 2 horas")
    // No tags loaded server-side → a neutral label, never the raw id.
    expect(html).toContain("Etiqueta selecionada")
    expect(html).not.toContain("tag-uuid")
    expect(html).toContain("Distribuição circular entre os responsáveis")
    // Cards are numbered and selectable.
    expect(html).toContain("Ação 1")
    expect(html).toContain("Ação 4")
    expect(html).toContain('data-step-cid="c_')
  })

  it("renders the create_task action with its title + due summary", () => {
    const html = render({
      steps: [
        step("create_task", { title: "Retornar para {{ contact.name }}", priority: "high", due_in_hours: 24 }),
        step("create_task", { title: "", due_in_hours: "" }),
      ],
    })
    expect(html).toContain("Criar tarefa")
    expect(html).toContain("Retornar para {{ contact.name }}")
    expect(html).toContain("prazo em 24 h")
    expect(html).toContain("Sem título ainda")
    expect(html).toContain("Ação 2")
  })

  it("lifts a leading if-only condition into the Conditions group with AND connectors", () => {
    const html = render({
      steps: [
        step("condition", { subject: "message_content", operand: "preço", value: "preço" }, {
          yes: [
            step("condition", { subject: "time_of_day", operand: "09:00-18:00", value: "" }, {
              yes: [step("send_message", { text: "Tabela de preços" })],
              no: [],
            }),
          ],
          no: [],
        }),
      ],
    })
    expect(html).toContain("Condição 1")
    expect(html).toContain("Condição 2")
    expect(html).toContain("Mensagem contém &quot;preço&quot;")
    expect(html).toContain("Horário entre 09:00 e 18:00")
    // The innermost actions still render as the actions list.
    expect(html).toContain("Tabela de preços")
    expect(html).not.toContain("Sem condições")
  })

  it("keeps a condition with an else branch as a branching action (Yes / No columns)", () => {
    const html = render({
      steps: [
        step("condition", { subject: "tag_presence", operand: "vip", value: "" }, {
          yes: [step("send_message", { text: "Atendimento VIP" })],
          no: [step("close_conversation", {})],
        }),
      ],
    })
    expect(html).toContain("Sem condições")
    expect(html).toContain(">Sim<")
    expect(html).toContain(">Não<")
    expect(html).toContain("Atendimento VIP")
    expect(html).toContain("Marca a conversa como resolvida")
  })
})

describe("step serialisation", () => {
  it("round-trips server steps through the builder shape", () => {
    const server = [
      {
        id: "a",
        step_type: "condition",
        step_config: { subject: "tag_presence", operand: "t1", value: "" },
        branches: {
          yes: [{ id: "b", step_type: "send_message", step_config: { text: "hi" }, branches: { yes: [], no: [] } }],
          no: [],
        },
      },
    ]
    const api = toApiSteps(fromServerSteps(server))
    expect(api).toEqual([
      {
        step_type: "condition",
        step_config: { subject: "tag_presence", operand: "t1", value: "" },
        branches: {
          yes: [{ step_type: "send_message", step_config: { text: "hi" }, branches: undefined }],
          no: [],
        },
      },
    ])
  })
})
