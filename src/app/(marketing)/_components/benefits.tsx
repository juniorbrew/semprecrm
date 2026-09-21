import { Inbox, Users, GitBranch, ListChecks, Send, Workflow, CalendarClock } from "lucide-react";

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// The 3 benefits with the most direct line to "vender mais" / "não perder
// venda" get the featured treatment; the rest support them. Splitting a flat
// 7-item grid this way also sidesteps the orphaned-last-card layout a plain
// 3-column grid produces with an odd count.
const FEATURED_BENEFITS = [
  {
    icon: Inbox,
    title: "Atenda o WhatsApp em equipe, sem perder conversa",
    description:
      "Uma caixa de entrada compartilhada para toda a equipe, com atribuição de conversas por agente.",
  },
  {
    icon: GitBranch,
    title: "Acompanhe cada oportunidade até fechar",
    description: "Funil de vendas visual (Kanban) ligado direto às conversas do WhatsApp.",
  },
  {
    icon: Workflow,
    title: "Automatize o repetitivo",
    description: "Fluxos e automações para respostas, tags e etapas do funil, sem precisar programar.",
  },
] as const;

const SUPPORTING_BENEFITS = [
  {
    icon: Users,
    title: "Toda a informação do cliente em um só lugar",
    description: "Contatos com tags e campos personalizados.",
  },
  {
    icon: ListChecks,
    title: "Organize o que sua equipe precisa fazer",
    description: "Tarefas com status personalizáveis, em lista ou em quadro.",
  },
  {
    icon: Send,
    title: "Envie campanhas por WhatsApp",
    description: "Disparos em massa com modelos aprovados pela Meta.",
  },
  {
    icon: CalendarClock,
    title: "Agenda sincronizada",
    description: "Compromissos integrados com Google Calendar e Outlook.",
  },
] as const;

export function Benefits() {
  return (
    <section id="beneficios" className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-balance text-3xl font-semibold tracking-tight text-foreground">
          Tudo que sua equipe precisa para vender e atender pelo WhatsApp
        </h2>
        <p className="mt-3 text-muted-foreground">
          Sem planilhas paralelas, sem WhatsApp Web aberto em dez celulares diferentes.
        </p>
      </div>
      <div className="mt-12 grid gap-4 sm:grid-cols-3">
        {FEATURED_BENEFITS.map((benefit) => (
          <Card key={benefit.title} className="bg-card-2">
            <CardHeader>
              <benefit.icon aria-hidden="true" className="mb-2 size-7 text-primary" />
              <CardTitle className="text-lg">
                <h3>{benefit.title}</h3>
              </CardTitle>
              <CardDescription>{benefit.description}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
      <div className="mt-4 grid gap-x-6 gap-y-4 rounded-xl border border-border p-6 sm:grid-cols-2 lg:grid-cols-4">
        {SUPPORTING_BENEFITS.map((benefit) => (
          <div key={benefit.title} className="flex items-start gap-3">
            <benefit.icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div>
              <h3 className="text-sm font-medium text-foreground">{benefit.title}</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">{benefit.description}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
