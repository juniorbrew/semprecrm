import { UserPlus, Smartphone, UsersRound, MessageSquareText } from "lucide-react";

const STEPS = [
  {
    icon: UserPlus,
    title: "Crie sua conta",
    description: "Cadastro como pessoa física ou jurídica, em menos de um minuto.",
  },
  {
    icon: Smartphone,
    title: "Configure seu WhatsApp",
    description: "Conecte pela API oficial da Meta ou leia um QR code — você escolhe.",
  },
  {
    icon: UsersRound,
    title: "Convide sua equipe",
    description:
      "Envie um link de convite e defina o papel de cada pessoa (administrador, agente ou visualizador).",
  },
  {
    icon: MessageSquareText,
    title: "Atenda, venda e automatize",
    description: "Sua equipe já começa a trabalhar na caixa de entrada, no funil e nas tarefas.",
  },
] as const;

export function HowItWorks() {
  return (
    <section id="como-funciona" className="border-t border-border bg-muted/40 py-16">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-foreground">Como funciona</h2>
          <p className="mt-3 text-muted-foreground">Do cadastro ao primeiro atendimento, em quatro passos.</p>
        </div>
        <ol className="mt-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, index) => (
            <li key={step.title} className="space-y-3">
              <div className="flex size-10 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                {index + 1}
              </div>
              <step.icon className="size-5 text-primary" />
              <p className="font-medium text-foreground">{step.title}</p>
              <p className="text-sm text-muted-foreground">{step.description}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
