import type { Metadata } from "next";

import { Hero } from "./_components/hero";
import { Benefits } from "./_components/benefits";
import { HowItWorks } from "./_components/how-it-works";
import { Features } from "./_components/features";
import { Audience } from "./_components/audience";
import { DemoShowcase } from "./_components/demo-showcase";
import { Faq } from "./_components/faq";
import { CtaBanner } from "./_components/cta-banner";

export const metadata: Metadata = {
  title: "CRM para WhatsApp que sua equipe vai usar de verdade",
  description:
    "SempreCRM centraliza o WhatsApp da sua empresa: caixa de entrada compartilhada, funil de vendas, tarefas e automação em um só lugar.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "SempreCRM — CRM para WhatsApp",
    description:
      "Centralize o WhatsApp da sua empresa: caixa de entrada compartilhada, funil de vendas, tarefas e automação.",
    url: "/",
    type: "website",
  },
};

export default function HomePage() {
  return (
    <>
      <Hero />
      <Benefits />
      <HowItWorks />
      <Features />
      <Audience />
      <DemoShowcase />
      <Faq />
      <CtaBanner />
    </>
  );
}
