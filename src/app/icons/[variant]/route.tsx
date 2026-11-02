import { ImageResponse } from 'next/og';

import { BrandMark } from '@/lib/pwa/brand-mark';

// Installed-app icons listed in app/manifest.ts. `maskable` fills the
// whole square and keeps the glyph inside the central safe zone, so
// Android can crop it to any shape.
export const ICON_VARIANTS = {
  '192': { px: 192, radius: 36, glyph: 116 },
  '512': { px: 512, radius: 96, glyph: 308 },
  maskable: { px: 512, radius: 0, glyph: 240 },
} as const;

type Variant = keyof typeof ICON_VARIANTS;

export const dynamic = 'force-static';

export function generateStaticParams() {
  return Object.keys(ICON_VARIANTS).map((variant) => ({ variant }));
}

export async function GET(_req: Request, { params }: { params: Promise<{ variant: string }> }) {
  const { variant } = await params;
  if (!Object.hasOwn(ICON_VARIANTS, variant)) return new Response('Not found', { status: 404 });
  const v = ICON_VARIANTS[variant as Variant];
  return new ImageResponse(<BrandMark radius={v.radius} glyph={v.glyph} />, { width: v.px, height: v.px });
}
