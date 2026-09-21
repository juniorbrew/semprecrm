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

// null = sem preço fixo publicado (planos "fale com a gente").
const PLAN_PRICES: Record<Plan, number | null> = {
  trial: 0,
  basico: 59.9,
  pro: 89.9,
  empresa: null,
};

function formatPrice(plan: Plan): { value: string; suffix: string } {
  const price = PLAN_PRICES[plan];
  if (price === null) return { value: "Personalizado", suffix: "" };
  if (price === 0) return { value: "Grátis", suffix: "por 14 dias" };
  return {
    value: price.toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
      minimumFractionDigits: 2,
    }),
    suffix: "/mês",
  };
}

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

// pt-BR plural forms per limit; null = unlimited.
const LIMIT_COPY = {
  max_users: { one: "usuário", many: "usuários", unlimited: "Usuários ilimitados" },
  max_channels: { one: "canal de WhatsApp", many: "canais de WhatsApp", unlimited: "Canais de WhatsApp ilimitados" },
} as const;

function LimitLine({ value, copy }: { value: number | null; copy: (typeof LIMIT_COPY)[keyof typeof LIMIT_COPY] }) {
  if (value === null) {
    return (
      <p>
        <strong>{copy.unlimited}</strong>
      </p>
    );
  }
  return (
    <p>
      <strong className="tabular-nums">{value}</strong> {value === 1 ? copy.one : copy.many}
    </p>
  );
}

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="text-balance text-4xl font-semibold tracking-tight text-foreground">Planos</h1>
        <p className="mt-3 text-muted-foreground">
          Comece com 14 dias de teste grátis, com acesso a todos os módulos. Fale com a nossa
          equipe para saber qual plano cabe melhor no tamanho da sua operação.
        </p>
      </div>
      <div className="mt-12 grid gap-6 lg:grid-cols-4">
        {PLAN_ORDER.map((plan) => {
          const definition = PLAN_CATALOG[plan];
          const isEmpresa = plan === "empresa";
          const price = formatPrice(plan);
          return (
            <Card key={plan} className={isEmpresa ? "ring-2 ring-primary" : undefined}>
              <CardHeader>
                <CardTitle className="text-lg">
                  <h2>{PLAN_LABELS_PT[plan]}</h2>
                </CardTitle>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-3xl font-semibold tracking-tight tabular-nums text-foreground">{price.value}</span>
                  {price.suffix && <span className="text-sm text-muted-foreground">{price.suffix}</span>}
                </div>
                <CardDescription>{PLAN_TAGLINES[plan]}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1 text-sm text-foreground">
                  <LimitLine value={definition.limits.max_users} copy={LIMIT_COPY.max_users} />
                  <LimitLine value={definition.limits.max_channels} copy={LIMIT_COPY.max_channels} />
                </div>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  {definition.modules.map((moduleKey) => (
                    <li key={moduleKey} className="flex items-center gap-2">
                      <Check aria-hidden="true" className="size-4 shrink-0 text-primary" />
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
