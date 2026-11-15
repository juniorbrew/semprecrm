// Installed-app icon of a booking page: the business' initial on its colour.
// (The uploaded logo stays on the page header; a generated letter is always
// square, sharp and readable at any size.)

import { ImageResponse } from 'next/og'

import { isValidSlug } from '@/lib/booking-page/core'
import { loadPageBySlug, loadPublicPage, pageState } from '@/lib/booking-page/server'
import { normalizeHexColor, primaryForeground } from '@/lib/branding'
import { supabaseAdmin } from '@/lib/flows/admin-client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const VARIANTS = {
  '180': { px: 180, radius: 0, font: 100 },
  '192': { px: 192, radius: 36, font: 110 },
  '512': { px: 512, radius: 96, font: 290 },
  maskable: { px: 512, radius: 0, font: 220 },
} as const

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string; variant: string }> }) {
  const { slug, variant } = await params
  if (!isValidSlug(slug) || !Object.hasOwn(VARIANTS, variant)) return new Response('Not found', { status: 404 })
  const db = supabaseAdmin()
  const row = await loadPageBySlug(db, slug)
  const state = await pageState(db, row)
  if (!row || state === 'off') return new Response('Not found', { status: 404 })
  const page = await loadPublicPage(db, row, state)
  const color = normalizeHexColor(page.color) ?? '#0f172a'
  const v = VARIANTS[variant as keyof typeof VARIANTS]
  const letter = (page.name.trim()[0] ?? 'A').toUpperCase()
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: color,
          color: primaryForeground(color),
          borderRadius: v.radius,
          fontSize: v.font,
          fontWeight: 700,
        }}
      >
        {letter}
      </div>
    ),
    { width: v.px, height: v.px, headers: { 'Cache-Control': 'public, max-age=3600' } },
  )
}
