import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

const FAQS = [
  {
    question: "Preciso da API oficial do WhatsApp ou posso usar meu número normal?",
    answer:
      "Os dois funcionam. Você pode conectar pela API oficial do WhatsApp Business (Meta) ou parear um número existente por QR code, como o WhatsApp Web.",
  },
  {
    question: "Dá para convidar minha equipe depois de criar a conta?",
    answer:
      "Sim. Depois de criar a conta, você gera um link de convite e escolhe o papel de cada pessoa (administrador, agente ou visualizador).",
  },
  {
    question: "Meus dados e conversas ficam seguros?",
    answer:
      "Cada conta tem seus dados isolados no banco por regras de segurança em nível de linha (RLS), e o sistema conta com ferramentas de conformidade com a LGPD.",
  },
  {
    question: "Posso testar antes de decidir?",
    answer:
      "Sim, o teste é gratuito por 14 dias e dá acesso a todos os módulos do sistema, sem precisar de cartão de crédito.",
  },
  {
    question: "O que acontece quando o teste grátis termina?",
    answer:
      "Fale com a nossa equipe para escolher o plano ideal para o tamanho da sua operação — Básico, Pro ou Empresa.",
  },
] as const;

export function Faq() {
  return (
    <section className="border-t border-border py-16">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
        <h2 className="text-center text-3xl font-semibold tracking-tight text-foreground">
          Perguntas frequentes
        </h2>
        <Accordion className="mt-10">
          {FAQS.map((faq, index) => (
            <AccordionItem key={faq.question} value={String(index)}>
              <AccordionTrigger>{faq.question}</AccordionTrigger>
              <AccordionContent>
                <p className="text-muted-foreground">{faq.answer}</p>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
