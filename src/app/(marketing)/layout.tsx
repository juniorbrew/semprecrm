import type { Metadata } from "next";

import { SiteHeader } from "./_components/site-header";
import { SiteFooter } from "./_components/site-footer";
import { Analytics } from "./_components/analytics";

// Overrides the root layout's `robots: { index: false, follow: false }`
// (src/app/layout.tsx:28-31) for every route under this group only.
// Next.js merges metadata per segment — (auth), (dashboard) and
// /platform are untouched and keep inheriting the root's noindex.
export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://www.semprecrm.com.br"),
  robots: {
    index: true,
    follow: true,
  },
};

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col">
      {/* Skip link: first Tab stop on every marketing page, visible only on focus. */}
      <a
        href="#conteudo"
        className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        Pular para o conteúdo
      </a>
      <SiteHeader />
      <main id="conteudo" tabIndex={-1} className="flex-1 outline-none">
        {children}
      </main>
      <SiteFooter />
      <Analytics />
    </div>
  );
}
