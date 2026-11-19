import { ImageResponse } from 'next/og';

import { BrandMark } from '@/lib/pwa/brand-mark';
import { ICON_VARIANTS } from '@/lib/pwa/icon-variants';

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
