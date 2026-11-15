// /agendar/[slug] — the public booking page (migration 114). Server side:
// the page's public data (same as GET /api/agendar/[slug]), the business'
// name / colour for the tab, the install manifest of THIS business. The
// booking itself runs in the client component against /api/agendar/[slug]/*.

import type { Metadata, Viewport } from 'next'
import { notFound } from 'next/navigation'
import { cache } from 'react'

import { BookingApp } from '@/components/booking-page/booking-app'
import { isValidSlug } from '@/lib/booking-page/core'
import { loadPageBySlug, loadPublicPage, pageState, type PublicPage } from '@/lib/booking-page/server'
import { brandingCssVars, normalizeHexColor } from '@/lib/branding'
import { supabaseAdmin } from '@/lib/flows/admin-client'

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ slug: string }> }

// generateMetadata, generateViewport and the page share one load per request.
const load = cache(async (slug: string): Promise<PublicPage | null> => {
  if (!isValidSlug(slug)) return null
  const db = supabaseAdmin()
  const page = await loadPageBySlug(db, slug)
  const state = await pageState(db, page)
  if (!page || state === 'off') return null
  return loadPublicPage(db, page, state)
})

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const page = await load(slug)
  if (!page) return { title: { absolute: 'Página não encontrada' } }
  return {
    title: { absolute: `Agendar — ${page.name}` },
    description: page.intro ?? `Agende seu horário em ${page.name}.`,
    applicationName: page.name,
    manifest: `/agendar/${slug}/manifest.webmanifest`,
    appleWebApp: { capable: true, title: page.name, statusBarStyle: 'default' },
    icons: {
      icon: [{ url: `/agendar/${slug}/icone/192` }],
      apple: [{ url: `/agendar/${slug}/icone/180`, sizes: '180x180', type: 'image/png' }],
    },
  }
}

export async function generateViewport({ params }: Props): Promise<Viewport> {
  const { slug } = await params
  const page = await load(slug)
  return { themeColor: normalizeHexColor(page?.color) ?? '#0f172a' }
}

export default async function BookingPage({ params }: Props) {
  const { slug } = await params
  const page = await load(slug)
  if (!page) notFound()
  return (
    <div style={brandingCssVars(page.color) as React.CSSProperties} className="min-h-dvh bg-background">
      <BookingApp page={page} />
    </div>
  )
}
