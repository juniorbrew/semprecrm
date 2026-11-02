import { ImageResponse } from "next/og";

import { BrandMark } from "@/lib/pwa/brand-mark";

// iPhone/iPad home-screen icon ("Adicionar à Tela de Início"). Square on
// purpose: iOS rounds the corners itself.

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(<BrandMark radius={0} glyph={104} />, { ...size });
}
