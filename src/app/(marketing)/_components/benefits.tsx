import { Inbox, Users, GitBranch, ListChecks, Send, Workflow, CalendarClock } from "lucide-react";

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const BENEFITS = [
  {
    icon: Inbox,
    title: "Atenda o WhatsApp em equipe, sem perder conversa",
    description:
      "Uma caixa de entrada compartilhada para toda a equipe, com atribuição de conversas por agente.",
  },
  {
    icon: Users,
    title: "Toda a informação do cliente em um só lugar",
    description: "Contatos com tags e campos personalizados — sem planilha, sem informação espalhada.",
  },
  {
    icon: GitBranch,
    title: "Acompanhe cada oportunidade até fechar",
    description: "Funil de vendas visual (Kanban) ligado direto às conversas do WhatsApp.",
  },
  {
    icon: ListChecks,
    title: "Organize o que sua equipe precisa fazer",
    description: "Tarefas com status personalizáveis, em visão de lista ou de quadro.",
  },
  {
    icon: Send,
    title: "Envie campanhas por WhatsApp",
    description: "Disparos em massa com modelos aprovados pela Meta e acompanhamento de entrega e leitura.",
  },
  {
    icon: Workflow,
    title: "Automatize o repetitivo",
    description: "Fluxos e automações para respostas, tags e etapas do funil, sem precisar programar.",
  },
  {
    icon: CalendarClock,
    title: "Agenda sincronizada",
    description: "Compromissos integrados com Google Calendar e Outlook, para toda a equipe.",
  },
] as const;

export function Benefits() {
  return (
    <section id="beneficios" className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-foreground">
          Tudo que sua equipe precisa para vender e atender pelo WhatsApp
        </h2>
        <p className="mt-3 text-muted-foreground">
          Sem planilhas paralelas, sem WhatsApp Web aberto em dez celulares diferentes.
        </p>
      </div>
      <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {BENEFITS.map((benefit) => (
          <Card key={benefit.title}>
            <CardHeader>
              <benefit.icon className="mb-2 size-6 text-primary" />
              <CardTitle>{benefit.title}</CardTitle>
              <CardDescription>{benefit.description}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
    </section>
  );
}
