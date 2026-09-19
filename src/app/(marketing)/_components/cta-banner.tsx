import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";

export function CtaBanner() {
  return (
    <section className="border-t border-border bg-primary/5 py-16">
      <div className="mx-auto max-w-3xl px-4 text-center sm:px-6 lg:px-8">
        <h2 className="text-3xl font-semibold tracking-tight text-foreground">
          Pronto para organizar o WhatsApp da sua empresa?
        </h2>
        <p className="mt-3 text-muted-foreground">
          Crie sua conta gratuita em menos de um minuto. Sem cartão de crédito.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/signup"
            data-analytics="cta_start_click"
            className={buttonVariants({ variant: "default", size: "lg", className: "px-6" })}
          >
            Começar grátis
          </Link>
          <Link
            href="/contato"
            className={buttonVariants({ variant: "outline", size: "lg", className: "px-6" })}
          >
            Falar com nossa equipe
          </Link>
        </div>
      </div>
    </section>
  );
}
