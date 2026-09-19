import { KeyRound, MessageCircle, MessagesSquare, Palette, ShieldCheck, Webhook } from "lucide-react";

const FEATURES = [
  {
    icon: MessageCircle,
    title: "WhatsApp oficial (Meta) ou QR code",
    description:
      "Conecte pela API oficial do WhatsApp Business ou pareie um número existente por QR code — sua escolha, sem travar sua operação.",
  },
  {
    icon: Webhook,
    title: "Captura de leads por webhook",
    description:
      "Receba leads de landing pages, formulários ou automações externas direto no seu funil, já com contato e negócio criados.",
  },
  {
    icon: MessagesSquare,
    title: "Chat interno da equipe",
    description: "Converse com o time sem sair do sistema — separado da caixa de entrada do cliente.",
  },
  {
    icon: Palette,
    title: "Marca própria (white-label)",
    description: "Personalize o nome e o logo do sistema para a sua empresa.",
  },
  {
    icon: ShieldCheck,
    title: "LGPD e trilha de auditoria",
    description: "Ferramentas de conformidade com a LGPD e registro de ações relevantes da conta.",
  },
  {
    icon: KeyRound,
    title: "Autenticação em duas etapas",
    description: "Proteja o acesso da sua conta com verificação em duas etapas (TOTP).",
  },
] as const;

export function Features() {
  return (
    <section id="funcionalidades" className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-foreground">
          Feito para a operação real da sua empresa
        </h2>
        <p className="mt-3 text-muted-foreground">
          Recursos que resolvem detalhes do dia a dia de quem vende e atende pelo WhatsApp no Brasil.
        </p>
      </div>
      <div className="mt-12 grid gap-x-8 gap-y-6 sm:grid-cols-2">
        {FEATURES.map((feature) => (
          <div key={feature.title} className="flex gap-4">
            <feature.icon className="mt-1 size-5 shrink-0 text-primary" />
            <div>
              <p className="font-medium text-foreground">{feature.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{feature.description}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
