// The install manifest of ONE business' booking page: its name, colour and
// icon, opening on /agendar/<slug>. Android installs it as that business' app;
// on iPhone the page shows the "Adicionar à Tela de Início" steps.

import { isValidSlug } from '@/lib/booking-page/core'
import { loadPageBySlug, loadPublicPage, pageState } from '@/lib/booking-page/server'
import { normalizeHexColor } from '@/lib/branding'
import { supabaseAdmin } from '@/lib/flows/admin-client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  if (!isValidSlug(slug)) return new Response('Not found', { status: 404 })
  const db = supabaseAdmin()
  const row = await loadPageBySlug(db, slug)
  const state = await pageState(db, row)
  if (!row || state === 'off') return new Response('Not found', { status: 404 })
  const page = await loadPublicPage(db, row, state)
  const color = normalizeHexColor(page.color) ?? '#0f172a'
  const base = `/agendar/${slug}`
  const manifest = {
    id: base,
    name: page.name,
    short_name: page.name.slice(0, 24),
    description: `Agende seu horário em ${page.name}.`,
    lang: 'pt-BR',
    start_url: base,
    scope: base,
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: color,
    icons: [
      { src: `${base}/icone/192`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `${base}/icone/512`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `${base}/icone/maskable`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
  return new Response(JSON.stringify(manifest), {
    headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=300' },
  })
}
