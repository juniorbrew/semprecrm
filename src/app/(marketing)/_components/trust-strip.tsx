import { KeyRound, Lock, ShieldCheck } from "lucide-react";

// Every claim here already appears elsewhere on the site (features.tsx,
// faq.tsx) — this section only regroups real, existing facts as a
// reassurance beat right before the closing CTA, instead of inventing
// social proof the product doesn't have yet.
const TRUST_POINTS = [
  {
    icon: Lock,
    title: "Dados isolados por conta",
    description: "Cada empresa só acessa os próprios dados, protegidos por regras de segurança no banco (RLS).",
  },
  {
    icon: ShieldCheck,
    title: "Conformidade com a LGPD",
    description: "Ferramentas de conformidade e trilha de auditoria das ações da conta.",
  },
  {
    icon: KeyRound,
    title: "Autenticação em duas etapas",
    description: "Proteja o acesso da conta com verificação em duas etapas (TOTP).",
  },
] as const;

export function TrustStrip() {
  return (
    <section aria-labelledby="trust-heading" className="border-y border-border bg-muted/40 py-12">
      <h2 id="trust-heading" className="sr-only">
        Segurança e privacidade
      </h2>
      <div className="mx-auto grid max-w-6xl gap-8 px-4 sm:grid-cols-3 sm:px-6 lg:px-8">
        {TRUST_POINTS.map((point) => (
          <div key={point.title} className="text-center">
            <point.icon aria-hidden="true" className="mx-auto size-5 text-primary" />
            <h3 className="mt-3 text-sm font-medium text-foreground">{point.title}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{point.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
