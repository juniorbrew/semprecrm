import { Briefcase, HeartHandshake, Store } from "lucide-react";

const PROFILES = [
  {
    icon: Store,
    title: "Pequenas e médias empresas",
    description: "Times de vendas e atendimento que hoje dependem só do WhatsApp comum.",
  },
  {
    icon: HeartHandshake,
    title: "Equipes de atendimento e suporte",
    description: "Várias pessoas atendendo o mesmo número, sem perder o histórico da conversa.",
  },
  {
    icon: Briefcase,
    title: "Times comerciais",
    description: "Quem precisa de um funil de vendas simples, ligado direto às conversas.",
  },
] as const;

export function Audience() {
  return (
    <section className="border-t border-border bg-muted/40 py-16">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-balance text-3xl font-semibold tracking-tight text-foreground">Para quem é o SempreCRM</h2>
          <p className="mt-3 text-muted-foreground">
            Empresas brasileiras de pequeno e médio porte que vendem e atendem pelo WhatsApp.
          </p>
        </div>
        <div className="mt-10 flex flex-col divide-y divide-border sm:flex-row sm:divide-x sm:divide-y-0">
          {PROFILES.map((profile) => (
            <div key={profile.title} className="flex flex-1 items-start gap-3 py-4 sm:px-6 sm:py-0 first:sm:pl-0 last:sm:pr-0">
              <profile.icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
              <div>
                <h3 className="text-sm font-medium text-foreground">{profile.title}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{profile.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
