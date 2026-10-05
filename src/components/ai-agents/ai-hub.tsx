"use client";

import Link from "next/link";
import {
  BookOpen,
  Brain,
  ClipboardList,
  Flag,
  Gauge,
  GitFork,
  Key,
  Lightbulb,
  ListChecks,
  Plug,
  Route,
  Send,
  Sparkles,
  Bot,
  type LucideIcon,
} from "lucide-react";

import { SETTINGS_HEADING } from "@/components/settings/settings-group";
import { useLanguage } from "@/hooks/use-language";
import { cn } from "@/lib/utils";

interface HubItem {
  title: string;
  description: string;
  icon: LucideIcon;
  /** Absent = the module is not built yet ("Em breve", not a link). */
  href?: string;
}

interface HubGroup {
  title: string;
  items: HubItem[];
}

export const AI_HUB_GROUPS: HubGroup[] = [
  {
    title: "Montar o agente",
    items: [
      { title: "Agentes", description: "Quem atende por você: instruções, modelo e canais.", icon: Bot, href: "/ai/agents" },
      { title: "Credenciais", description: "A chave do provedor de IA que os agentes usam para pensar.", icon: Key, href: "/settings?tab=ai" },
      { title: "Provedores", description: "Qual inteligência atende cada parte do sistema.", icon: Plug, href: "/settings?tab=ai" },
      { title: "Roteadores", description: "Qual agente pega qual conversa, e quando o humano assume.", icon: Route, href: "/settings?tab=support" },
      { title: "Follow-ups", description: "Como o agente retoma uma conversa que esfriou.", icon: GitFork, href: "/flows" },
    ],
  },
  {
    title: "Ensinar o agente",
    items: [
      { title: "Conhecimento", description: "Os materiais que o agente consulta antes de responder.", icon: BookOpen, href: "/settings?tab=ai" },
      { title: "Memória", description: "O que o agente já aprendeu sobre a sua operação.", icon: Brain },
      { title: "Skills", description: "As ações que o agente pode executar sozinho no atendimento.", icon: Sparkles },
    ],
  },
  {
    title: "Acompanhar o agente",
    items: [
      { title: "Casos", description: "Os atendimentos que o agente conduziu, do início ao desfecho.", icon: ClipboardList },
      { title: "Alertas", description: "O que a IA encontrou e precisa de uma decisão sua.", icon: Flag },
      { title: "Aviso no WhatsApp", description: "Receber no WhatsApp quando o assistente abrir um caso.", icon: Send },
      { title: "Propostas", description: "Melhorias que a IA sugere, esperando a sua decisão.", icon: Lightbulb },
      { title: "Execuções", description: "O que a IA fez e, quando falhou, o que aconteceu.", icon: ListChecks },
      { title: "Uso e orçamento", description: "Quanto a IA consumiu e qual é o teto de gasto do mês.", icon: Gauge, href: "/ai/uso" },
    ],
  },
];

const ROW =
  "flex items-start gap-3 px-1 py-3 outline-none";

function Row({ item, soon }: { item: HubItem; soon: string }) {
  const { t } = useLanguage();
  const body = (
    <>
      <item.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{t(item.title)}</span>
        <span className="block text-sm text-muted-foreground">{t(item.description)}</span>
      </span>
      {item.href ? null : <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">{soon}</span>}
    </>
  );
  if (!item.href) return <li className={cn(ROW, "opacity-80")}>{body}</li>;
  return (
    <li>
      <Link
        href={item.href}
        className={cn(ROW, "rounded-md transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50")}
      >
        {body}
      </Link>
    </li>
  );
}

/** Landing of the AI area: every piece of the agent, grouped by job. */
export function AiHub() {
  const { t } = useLanguage();
  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-6 sm:px-6">
      <header className="space-y-1">
        <h1 className="text-base font-semibold text-foreground">{t("Agente de IA")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Tudo que define quem atende por você, e como acompanhar o que ele faz.")}
        </p>
      </header>
      {AI_HUB_GROUPS.map((group) => (
        <section key={group.title} className="space-y-1 border-t border-border pt-4 first:border-t-0 first:pt-0">
          <h2 className={SETTINGS_HEADING}>{t(group.title)}</h2>
          <ul className="divide-y divide-border">
            {group.items.map((item) => (
              <Row key={item.title} item={item} soon={t("Em breve")} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
