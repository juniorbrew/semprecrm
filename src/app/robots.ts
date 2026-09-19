import type { MetadataRoute } from "next";

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.semprecrm.com.br";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/precos", "/contato"],
        disallow: [
          "/dashboard",
          "/inbox",
          "/contacts",
          "/pipelines",
          "/tasks",
          "/chat",
          "/agenda",
          "/broadcasts",
          "/automations",
          "/flows",
          "/login",
          "/signup",
          "/forgot-password",
          "/mfa",
          "/join",
          "/platform",
          "/api",
        ],
      },
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
  };
}
