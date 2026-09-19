import type { MetadataRoute } from "next";

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.semprecrm.com.br";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return [
    { url: `${BASE_URL}/`, lastModified, changeFrequency: "monthly", priority: 1 },
    { url: `${BASE_URL}/precos`, lastModified, changeFrequency: "monthly", priority: 0.8 },
    { url: `${BASE_URL}/contato`, lastModified, changeFrequency: "yearly", priority: 0.5 },
  ];
}
