import type { Metadata } from "next";
import { Mail } from "lucide-react";

import { ContactForm } from "../_components/contact-form";

export const metadata: Metadata = {
  title: "Contato",
  description: "Fale com a equipe do SempreCRM. Tire suas dúvidas antes de começar ou fale sobre o plano Empresa.",
  alternates: { canonical: "/contato" },
};

export default function ContactPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 lg:px-8">
      <div className="text-center">
        <h1 className="text-4xl font-semibold tracking-tight text-foreground">Fale com a gente</h1>
        <p className="mt-3 text-muted-foreground">
          Dúvidas sobre o produto, sobre o plano Empresa ou qualquer outra coisa — é só mandar uma
          mensagem.
        </p>
      </div>
      <div className="mt-10 grid gap-10 sm:grid-cols-[1fr_1.4fr]">
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <Mail className="mt-0.5 size-5 shrink-0 text-primary" />
            <div>
              <p className="font-medium text-foreground">E-mail</p>
              <p className="text-sm text-muted-foreground">contato@semprecrm.com.br</p>
            </div>
          </div>
        </div>
        <ContactForm />
      </div>
    </div>
  );
}
