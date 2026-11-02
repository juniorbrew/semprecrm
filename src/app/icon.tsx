import { ImageResponse } from "next/og";

import { BrandMark } from "@/lib/pwa/brand-mark";

// Replaces the default Next.js favicon with the brand mark. Next.js
// renders this at build time and auto-injects <link rel="icon"> into
// <head>.
//
// This route takes precedence over src/app/favicon.ico, which is the
// Next.js default and can stay on disk harmlessly (or be removed).

export const runtime = "edge";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(<BrandMark radius={6} glyph={20} />, { ...size });
}
