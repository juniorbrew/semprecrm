import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";

export function Hero() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
      <div className="grid gap-10 lg:grid-cols-2 lg:items-center lg:gap-16">
        <div className="space-y-6">
          <span className="inline-flex items-center rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
            CRM para WhatsApp
          </span>
          <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
            O WhatsApp da sua empresa, organizado em um só lugar
          </h1>
          <p className="text-lg text-muted-foreground">
            O SempreCRM reúne a caixa de entrada da sua equipe, o funil de vendas, as tarefas e a
            automação num único sistema — para pequenas e médias empresas que vendem e atendem
            pelo WhatsApp.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/signup"
              data-analytics="cta_start_click"
              className={buttonVariants({ variant: "default", size: "lg", className: "px-6" })}
            >
              Começar grátis
            </Link>
            <Link
              href="/login"
              data-analytics="cta_login_click"
              className={buttonVariants({ variant: "outline", size: "lg", className: "px-6" })}
            >
              Entrar
            </Link>
          </div>
          <p className="text-sm text-muted-foreground">
            Teste grátis por 14 dias. Sem cartão de crédito.
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-2 shadow-2xl shadow-primary/10">
          <div className="rounded-xl border border-border bg-background p-6">
            <div className="mb-4 flex items-center gap-2">
              <span className="size-2.5 rounded-full bg-destructive/60" />
              <span className="size-2.5 rounded-full bg-amber-500/60" />
              <span className="size-2.5 rounded-full bg-emerald-500/60" />
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-lg bg-muted px-3 py-2">
                <span className="text-sm font-medium text-foreground">Caixa de entrada</span>
                <span className="rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground">
                  12 novas
                </span>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-muted px-3 py-2">
                <span className="text-sm font-medium text-foreground">Funil de vendas</span>
                <span className="text-xs text-muted-foreground">8 negócios abertos</span>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-muted px-3 py-2">
                <span className="text-sm font-medium text-foreground">Tarefas de hoje</span>
                <span className="text-xs text-muted-foreground">5 pendentes</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
