"use client";

import { useEffect } from "react";
import Script from "next/script";

import { trackEvent } from "@/lib/analytics";

const GA_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

/**
 * Loads GA4 and wires a document-level click listener so any
 * server-rendered element can opt into tracking with
 * `data-analytics="event_name"` — no need to turn CTAs into client
 * components just to fire an event. No-ops entirely when
 * NEXT_PUBLIC_GA_MEASUREMENT_ID is unset. Mounted once, in
 * (marketing)/layout.tsx — never on (auth)/(dashboard)/platform.
 */
export function Analytics() {
  useEffect(() => {
    if (!GA_ID) return;

    function handleClick(event: MouseEvent) {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(
        "[data-analytics]",
      );
      if (!target?.dataset.analytics) return;
      trackEvent(target.dataset.analytics);
    }

    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  if (!GA_ID) return null;

  return (
    <>
      <Script src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`} strategy="afterInteractive" />
      <Script id="ga4-init" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', '${GA_ID}');
        `}
      </Script>
    </>
  );
}
