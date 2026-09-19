import type { Metadata } from "next";

import { Hero } from "./_components/hero";
import { Benefits } from "./_components/benefits";
import { HowItWorks } from "./_components/how-it-works";
import { Features } from "./_components/features";
import { Audience } from "./_components/audience";
import { DemoShowcase } from "./_components/demo-showcase";
import { Faq } from "./_components/faq";
import { CtaBanner } from "./_components/cta-banner";

const DESCRIPTION =
  "SempreCRM centraliza o WhatsApp da sua empresa: caixa de entrada compartilhada, funil de vendas, tarefas e automação em um só lugar.";

export const metadata: Metadata = {
  title: "CRM para WhatsApp que sua equipe vai usar de verdade",
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    title: "SempreCRM — CRM para WhatsApp",
    description:
      "Centralize o WhatsApp da sua empresa: caixa de entrada compartilhada, funil de vendas, tarefas e automação.",
    url: "/",
    type: "website",
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "SempreCRM",
  description: DESCRIPTION,
  applicationCategory: "BusinessApplication",
  url: process.env.NEXT_PUBLIC_SITE_URL || "https://www.semprecrm.com.br",
};

export default function HomePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
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
