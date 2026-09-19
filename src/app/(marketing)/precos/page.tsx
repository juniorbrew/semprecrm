import type { Metadata } from "next";
import Link from "next/link";
import { Check } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { PLAN_CATALOG, type Module, type Plan } from "@/lib/plans";

export const metadata: Metadata = {
  title: "Preços",
  description:
    "Planos do SempreCRM: recursos e limites de cada plano. Teste grátis por 14 dias, sem cartão de crédito.",
  alternates: { canonical: "/precos" },
};

const PLAN_ORDER: Plan[] = ["trial", "basico", "pro", "empresa"];

// pt-BR plan names for the marketing site — src/lib/plans.ts's own
// PLAN_LABELS are English (they feed the in-app i18n catalogue via
// the global useLanguage()/EN_TO_PT translator, not this page), so
// this page keeps its own hardcoded translation rather than relying
// on the runtime translator rewriting matching text nodes.
const PLAN_LABELS_PT: Record<Plan, string> = {
  trial: "Teste",
  basico: "Básico",
  pro: "Pro",
  empresa: "Empresa",
};

const PLAN_TAGLINES: Record<Plan, string> = {
  trial: "Para testar tudo antes de decidir.",
  basico: "Para começar a organizar o essencial.",
  pro: "Para equipes que já vivem no funil e na automação.",
  empresa: "Para operações maiores, com múltiplos canais.",
};

// pt-BR labels for the marketing site — src/lib/plans.ts's own
// MODULE_LABELS are English (they feed the in-app i18n catalogue),
// but marketing copy is hardcoded pt-BR (see plan's Global
// Constraints), so this page keeps its own translation, matching
// the real sidebar nav labels (src/components/layout/sidebar.tsx).
const MODULE_LABELS_PT: Record<Module, string> = {
  inbox: "Caixa de entrada",
  contacts: "Contatos",
  dashboard: "Painel",
  pipelines: "Funis",
  tasks: "Tarefas",
  broadcasts: "Disparos",
  automations: "Automações",
  flows: "Fluxos",
  channel_official: "WhatsApp oficial (Meta)",
  channel_qr: "WhatsApp via QR code",
  lead_capture: "Captura de leads",
  white_label: "Marca própria",
  internal_chat: "Chat interno",
  calendar: "Agenda",
};

function formatLimit(value: number | null): string {
  return value === null ? "Ilimitado" : String(value);
}

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="text-4xl font-semibold tracking-tight text-foreground">Planos</h1>
        <p className="mt-3 text-muted-foreground">
          Comece com 14 dias de teste grátis, com acesso a todos os módulos. Fale com a nossa
          equipe para saber qual plano cabe melhor no tamanho da sua operação.
        </p>
      </div>
      <div className="mt-12 grid gap-6 lg:grid-cols-4">
        {PLAN_ORDER.map((plan) => {
          const definition = PLAN_CATALOG[plan];
          const isEmpresa = plan === "empresa";
          return (
            <Card key={plan} className={isEmpresa ? "ring-2 ring-primary" : undefined}>
              <CardHeader>
                <CardTitle className="text-lg">{PLAN_LABELS_PT[plan]}</CardTitle>
                <CardDescription>{PLAN_TAGLINES[plan]}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1 text-sm text-foreground">
                  <p>
                    <strong>{formatLimit(definition.limits.max_users)}</strong> usuário(s)
                  </p>
                  <p>
                    <strong>{formatLimit(definition.limits.max_channels)}</strong> canal(is) de WhatsApp
                  </p>
                </div>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  {definition.modules.map((moduleKey) => (
                    <li key={moduleKey} className="flex items-center gap-2">
                      <Check className="size-4 shrink-0 text-primary" />
                      {MODULE_LABELS_PT[moduleKey]}
                    </li>
                  ))}
                </ul>
              </CardContent>
              <CardFooter>
                <Link
                  href={isEmpresa ? "/contato" : "/signup"}
                  data-analytics={isEmpresa ? undefined : "cta_start_click"}
                  className={buttonVariants({
                    variant: isEmpresa ? "outline" : "default",
                    className: "w-full",
                  })}
                >
                  {isEmpresa ? "Falar com nossa equipe" : "Começar grátis"}
                </Link>
              </CardFooter>
            </Card>
          );
        })}
      </div>
      <p className="mt-8 text-center text-sm text-muted-foreground">
        Caixa de entrada e Contatos estão disponíveis em todos os planos.
      </p>
    </div>
  );
}
