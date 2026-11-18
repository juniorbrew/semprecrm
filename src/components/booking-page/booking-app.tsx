'use client'

// The customer side of the booking page (migration 113): pick a service, a
// professional (or anyone), a free time; confirm the phone once on WhatsApp;
// book; see / cancel / move upcoming appointments. Talks only to
// /api/agendar/<slug>/*; the session lives in an HttpOnly cookie there.
// Customer-facing, Brazil only: pt-BR text, no app i18n.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowLeft, CalendarCheck, Check, ChevronLeft, ChevronRight, Clock, Loader2, Mail, MessageCircle, Share, User } from 'lucide-react'

import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatDuration, formatPrice, groupSlotsByDay, shiftDate, todayIn } from '@/lib/agenda/ui'
import type { Slot } from '@/lib/agenda/types'
import type { MyAppointment, PublicPage, PublicService, SessionInfo } from '@/lib/booking-page/server'
import { INSTALL_PROMPT_EVENT, INSTALL_PROMPT_KEY } from '@/lib/pwa/install-prompt'

type Step = 'service' | 'professional' | 'time' | 'confirm' | 'details' | 'resume' | 'done'

/** What the customer picked, kept across the trip to Google and back. */
interface Pending {
  serviceId: string
  resourceId: string | null
  slot: Slot
}

const pendingKey = (slug: string) => `agendar:${slug}`

interface ApiError {
  error?: string
  signed_out?: boolean
  alternatives?: Slot[]
  reason?: string
}

/** Never throws: no connection comes back as status 0 (common on phones). */
async function api<T>(slug: string, path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: T & ApiError }> {
  let res: Response
  try {
    res = await fetch(`/api/agendar/${slug}${path}`, {
      ...init,
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
      cache: 'no-store',
    })
  } catch {
    return { ok: false, status: 0, data: { error: 'Sem conexão. Verifique a internet e tente novamente.' } as T & ApiError }
  }
  const data = (await res.json().catch(() => ({ error: 'Não foi possível concluir. Tente novamente.' }))) as T & ApiError
  return { ok: res.ok, status: res.status, data }
}

function fmtDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`)
  return new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' }).format(d).replace('.', '')
}

function fmtTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(iso))
}

function fmtWhen(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: tz }).format(
    new Date(iso),
  )
}

/** `arrival`: back from Google (?entrou=google / ?erro=…), read by the server page so both renders agree. */
export function BookingApp({ page, arrival }: { page: PublicPage; arrival: { google: boolean; error: string | null } }) {
  const [tab, setTab] = useState<'book' | 'mine'>('book')
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [checked, setChecked] = useState(false)
  useEffect(() => {
    if (arrival.google || arrival.error) window.history.replaceState(null, '', window.location.pathname)
    api<{ session: SessionInfo | null }>(page.slug, '').then((r) => {
      setSession(r.data.session ?? null)
      setChecked(true)
    })
  }, [arrival, page.slug])
  const signedIn = !!session
  const onSignedIn = useCallback((info: SessionInfo) => setSession(info), [])
  const onSignedOut = useCallback(() => setSession(null), [])
  const seeMine = useCallback(() => setTab('mine'), [])
  const seeBook = useCallback(() => setTab('book'), [])

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-lg flex-col px-4 pb-10">
      <header className="flex items-center gap-3 pt-6 pb-4">
        {page.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element -- logo from the business' own storage path
          <img src={page.logo_url} alt="" className="size-12 rounded-xl object-cover" />
        ) : (
          <div aria-hidden className="bg-primary text-primary-foreground flex size-12 items-center justify-center rounded-xl text-xl font-semibold">
            {(page.name.trim()[0] ?? 'A').toUpperCase()}
          </div>
        )}
        <div className="min-w-0">
          <h1 className="text-foreground truncate text-lg font-semibold">{page.name}</h1>
          <p className="text-muted-foreground text-sm">Agendamento online</p>
        </div>
      </header>

      {page.state !== 'ok' ? (
        <div role="status" className="bg-muted text-foreground rounded-xl p-4 text-sm">
          O agendamento online está indisponível no momento. Fale com a empresa para marcar seu horário.
        </div>
      ) : (
        <>
          <nav className="bg-muted mb-5 grid grid-cols-2 rounded-xl p-1 text-sm" aria-label="Seções">
            {(['book', 'mine'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                aria-current={tab === t ? 'page' : undefined}
                className={`rounded-lg py-2 font-medium transition-colors ${tab === t ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`}
              >
                {t === 'book' ? 'Agendar' : 'Meus horários'}
              </button>
            ))}
          </nav>
          {/* Kept mounted: switching tabs while waiting for the WhatsApp code must not drop the wait. */}
          <div hidden={tab !== 'book'}>
            <BookFlow
              page={page}
              session={session}
              ready={checked}
              arrival={arrival}
              onSignedIn={onSignedIn}
              onSeeMine={seeMine}
            />
          </div>
          {tab === 'mine' &&
            (checked ? (
              <Mine page={page} signedIn={signedIn} onSignedOut={onSignedOut} onBook={seeBook} />
            ) : (
              <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label="Carregando" />
            ))}
          <InstallHint name={page.name} />
        </>
      )}
    </div>
  )
}

// ------------------------------------------------------------
// Booking flow
// ------------------------------------------------------------

/** The choice saved before going to Google (read only when coming back from it). */
function readPending(slug: string, page: PublicPage): { service: PublicService; resourceId: string | null; slot: Slot } | null {
  try {
    const p = JSON.parse(sessionStorage.getItem(pendingKey(slug)) ?? 'null') as Pending | null
    const service = p ? page.services.find((x) => x.id === p.serviceId) : undefined
    return p && service ? { service, resourceId: p.resourceId, slot: p.slot } : null
  } catch {
    return null
  }
}

function BookFlow({
  page,
  session,
  ready,
  arrival,
  onSignedIn,
  onSeeMine,
}: {
  page: PublicPage
  session: SessionInfo | null
  /** The session check finished (until then nobody knows whether the customer is signed in). */
  ready: boolean
  arrival: { google: boolean; error: string | null }
  onSignedIn: (info: SessionInfo) => void
  onSeeMine: () => void
}) {
  // Back from Google: start from what the customer had picked.
  const fromGoogle = arrival.google || arrival.error === 'google'
  const [pending] = useState(() => (fromGoogle && typeof window !== 'undefined' ? readPending(page.slug, page) : null))
  const [step, setStep] = useState<Step>(fromGoogle ? 'resume' : 'service')
  const [arrivalError, setArrivalError] = useState(arrival.error)
  const [service, setService] = useState<PublicService | null>(pending?.service ?? null)
  const [resourceId, setResourceId] = useState<string | null>(pending?.resourceId ?? null)
  const [slot, setSlot] = useState<Slot | null>(pending?.slot ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [alternatives, setAlternatives] = useState<Slot[]>([])
  const [booked, setBooked] = useState<{ starts_at: string } | null>(null)
  // One key per chosen slot: a retry of the same slot (lost answer, double tap) is the same booking.
  const keyRef = useRef<{ startsAt: string; key: string } | null>(null)
  const inFlight = useRef(false)

  const pros = useMemo(
    () => (service ? page.resources.filter((r) => service.resource_ids.includes(r.id)) : []),
    [page.resources, service],
  )

  const book = useCallback(
    async (chosen: Slot, details?: { nome: string; celular: string; aceite: boolean }) => {
      if (!service || inFlight.current) return
      if (keyRef.current?.startsAt !== chosen.starts_at) keyRef.current = { startsAt: chosen.starts_at, key: crypto.randomUUID() }
      inFlight.current = true
      setBusy(true)
      setError(null)
      setAlternatives([])
      const r = await api<{ ok: boolean; starts_at: string }>(page.slug, '/agendar', {
        method: 'POST',
        body: JSON.stringify({ servico: service.id, profissional: resourceId, inicio: chosen.starts_at, chave: keyRef.current.key, ...details }),
      })
      inFlight.current = false
      setBusy(false)
      if (r.ok) {
        try {
          sessionStorage.removeItem(pendingKey(page.slug))
        } catch {
          // nothing saved
        }
        if (details && session) onSignedIn({ ...session, needs_phone: false })
        setBooked({ starts_at: r.data.starts_at })
        setStep('done')
        return
      }
      if (r.data.signed_out) {
        setStep('confirm')
        return
      }
      if (r.data.reason === 'needs_phone') {
        setStep('details')
        return
      }
      // A definitive refusal: the next attempt at this slot is a new booking.
      if (r.status >= 400 && r.status < 500) keyRef.current = null
      setError(r.data.error ?? 'Não foi possível agendar.')
      setAlternatives(r.data.alternatives ?? [])
      // Slot taken / limit: the server already kept the name + phone, so the next try needs only a time.
      if (r.status === 409 && r.data.reason !== 'contact') {
        if (details && session) onSignedIn({ ...session, needs_phone: false })
        setStep('time')
      }
      // Anything else with details: stay on the form, where the error shows.
    },
    [onSignedIn, page.slug, resourceId, service, session],
  )

  const pickSlot = (s: Slot) => {
    setSlot(s)
    setError(null)
    setAlternatives([])
    if (!session) setStep('confirm')
    else if (session.needs_phone) setStep('details')
    else void book(s)
  }

  // Before leaving for Google: remember the choice, to pick it up on the way back.
  const savePending = () => {
    if (!service || !slot) return
    try {
      sessionStorage.setItem(pendingKey(page.slug), JSON.stringify({ serviceId: service.id, resourceId, slot } satisfies Pending))
    } catch {
      // private mode: the customer just picks the time again
    }
  }



  const back = () => {
    setError(null)
    setAlternatives([])
    setStep(view === 'confirm' || view === 'details' || view === 'review' ? 'time' : step === 'time' ? (pros.length > 1 ? 'professional' : 'service') : 'service')
  }

  // 'resume' becomes a real step once we know who is signed in.
  const view: Step | 'loading' | 'review' =
    step !== 'resume'
      ? step
      : !ready
        ? 'loading'
        : !service || !slot
          ? 'service'
          : !session
            ? 'confirm'
            : session.needs_phone
              ? 'details'
              : 'review'

  if (step === 'done' && booked && service) {
    return (
      <section aria-live="polite" className="flex flex-col items-center gap-3 rounded-2xl border p-6 text-center">
        <div className="bg-primary text-primary-foreground flex size-12 items-center justify-center rounded-full">
          <Check className="size-6" aria-hidden />
        </div>
        <h2 className="text-lg font-semibold">Horário marcado!</h2>
        <p className="text-muted-foreground text-sm">
          {service.name} — <span className="text-foreground font-medium">{fmtWhen(booked.starts_at, page.timezone)}</span>
        </p>
        <p className="text-muted-foreground text-sm">Você vai receber um lembrete no WhatsApp antes do horário.</p>
        <div className="mt-2 flex w-full flex-col gap-2">
          <Button onClick={onSeeMine}>Ver meus horários</Button>
          <Button
            variant="outline"
            onClick={() => {
              setStep('service')
              setService(null)
              setSlot(null)
              setBooked(null)
            }}
          >
            Marcar outro horário
          </Button>
        </div>
      </section>
    )
  }

  return (
    <section className="flex flex-col gap-4">
      {arrivalError && (view === 'service' || view === 'confirm') && (
        <p role="alert" className="bg-destructive/10 text-destructive rounded-xl p-3 text-sm">
          {arrivalError === 'google'
            ? 'Não foi possível entrar com o Google. Tente de novo ou use outra opção.'
            : 'O agendamento online está indisponível no momento.'}
        </p>
      )}
      {view !== 'service' && view !== 'loading' && (
        <button type="button" onClick={back} className="text-muted-foreground flex w-fit items-center gap-1 text-sm">
          <ArrowLeft className="size-4" aria-hidden /> Voltar
        </button>
      )}

      {view === 'service' && (
        <>
          <h2 className="text-base font-semibold">Escolha o serviço</h2>
          {page.services.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nenhum serviço disponível para agendamento online no momento.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {page.services.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setService(s)
                      setArrivalError(null)
                      const only = s.resource_ids.length === 1 ? s.resource_ids[0] : null
                      setResourceId(only)
                      setStep(only ? 'time' : 'professional')
                    }}
                    className="hover:border-primary focus-visible:ring-ring flex w-full items-start justify-between gap-3 rounded-xl border p-4 text-left focus-visible:ring-2 focus-visible:outline-none"
                  >
                    <span className="min-w-0">
                      <span className="block font-medium">{s.name}</span>
                      {s.description && <span className="text-muted-foreground mt-0.5 block text-sm">{s.description}</span>}
                      <span className="text-muted-foreground mt-1 flex items-center gap-1 text-xs">
                        <Clock className="size-3.5" aria-hidden /> {formatDuration(s.duration_minutes)}
                      </span>
                    </span>
                    {s.price_cents != null && <span className="shrink-0 text-sm font-medium">{formatPrice(s.price_cents, 'pt-BR')}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {view === 'professional' && service && (
        <>
          <h2 className="text-base font-semibold">Com quem?</h2>
          <ul className="flex flex-col gap-2">
            <li>
              <ProButton
                name="Qualquer profissional"
                hint="O primeiro horário livre"
                onClick={() => {
                  setResourceId(null)
                  setStep('time')
                }}
              />
            </li>
            {pros.map((r) => (
              <li key={r.id}>
                <ProButton
                  name={r.name}
                  color={r.color}
                  onClick={() => {
                    setResourceId(r.id)
                    setStep('time')
                  }}
                />
              </li>
            ))}
          </ul>
        </>
      )}

      {view === 'time' && service && (
        <>
          <h2 className="text-base font-semibold">Escolha o horário</h2>
          <p className="text-muted-foreground -mt-2 text-sm">
            {service.name}
            {resourceId ? ` com ${page.resources.find((r) => r.id === resourceId)?.name ?? ''}` : ''}
          </p>
          {error && (
            <div role="alert" className="bg-destructive/10 text-destructive rounded-xl p-3 text-sm">
              {error}
              {alternatives.length > 0 && <span className="text-foreground mt-1 block">Horários próximos livres:</span>}
            </div>
          )}
          {alternatives.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {alternatives.map((s) => (
                <Button key={s.starts_at} variant="outline" size="sm" onClick={() => pickSlot(s)} disabled={busy}>
                  {fmtDay(todayIn(page.timezone, new Date(s.starts_at)))} {fmtTime(s.starts_at, page.timezone)}
                </Button>
              ))}
            </div>
          ) : null}
          <SlotPicker page={page} serviceId={service.id} resourceId={resourceId} disabled={busy} onPick={pickSlot} />
          {busy && (
            <p className="text-muted-foreground flex items-center gap-2 text-sm" aria-live="polite">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Marcando…
            </p>
          )}
        </>
      )}

      {view === 'loading' && <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label="Carregando" />}

      {view === 'review' && service && slot && (
        <div className="flex flex-col gap-4">
          <div className="bg-muted rounded-xl p-3 text-sm">
            <CalendarCheck className="mr-1 inline size-4 align-[-2px]" aria-hidden /> {service.name} — {fmtWhen(slot.starts_at, page.timezone)}
          </div>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <Button size="lg" disabled={busy} onClick={() => void book(slot)}>
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden />} Confirmar agendamento
          </Button>
        </div>
      )}

      {view === 'confirm' && service && slot && (
        <SignIn
          page={page}
          summary={`${service.name} — ${fmtWhen(slot.starts_at, page.timezone)}`}
          onLeaveForGoogle={savePending}
          onSignedIn={(info) => {
            onSignedIn(info)
            if (info.needs_phone) {
              setStep('details')
            } else {
              setStep('time')
              void book(slot)
            }
          }}
        />
      )}

      {view === 'details' && service && slot && (
        <Details
          page={page}
          summary={`${service.name} — ${fmtWhen(slot.starts_at, page.timezone)}`}
          initialName={session?.name ?? ''}
          busy={busy}
          error={error}
          onSubmit={(d) => {
            setStep('details')
            void book(slot, d)
          }}
        />
      )}
    </section>
  )
}

function ProButton({ name, hint, color, onClick }: { name: string; hint?: string; color?: string | null; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover:border-primary focus-visible:ring-ring flex w-full items-center gap-3 rounded-xl border p-3 text-left focus-visible:ring-2 focus-visible:outline-none"
    >
      <span
        aria-hidden
        className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
        style={color ? { background: color } : undefined}
      >
        {hint ? <User className="text-muted-foreground size-5" /> : (name.trim()[0] ?? '?').toUpperCase()}
      </span>
      <span>
        <span className="block font-medium">{name}</span>
        {hint && <span className="text-muted-foreground block text-xs">{hint}</span>}
      </span>
    </button>
  )
}

function SlotPicker({
  page,
  serviceId,
  resourceId,
  disabled,
  onPick,
}: {
  page: PublicPage
  serviceId: string
  resourceId: string | null
  disabled?: boolean
  onPick: (s: Slot) => void
}) {
  const today = todayIn(page.timezone)
  const [from, setFrom] = useState(today)
  const [day, setDay] = useState<string | null>(null)
  const query = useMemo(() => {
    const q = new URLSearchParams({ servico: serviceId, de: from })
    if (resourceId) q.set('profissional', resourceId)
    return q.toString()
  }, [serviceId, resourceId, from])
  // The answer remembers which query it belongs to: a new query is "loading" until its answer arrives.
  const [answer, setAnswer] = useState<{ query: string; slots: Slot[]; error: string | null } | null>(null)

  useEffect(() => {
    let alive = true
    api<{ slots: Slot[] }>(page.slug, `/horarios?${query}`).then((r) => {
      if (!alive) return
      setAnswer({ query, slots: r.ok ? r.data.slots : [], error: r.ok ? null : (r.data.error ?? 'Não foi possível carregar os horários.') })
    })
    return () => {
      alive = false
    }
  }, [page.slug, query])

  const state = answer?.query === query ? { loading: false, ...answer } : { loading: true, slots: [] as Slot[], error: null }

  const days = useMemo(() => groupSlotsByDay(answer?.query === query ? answer.slots : [], page.timezone), [answer, query, page.timezone])
  const current = days.find((d) => d.date === day) ?? days[0]

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" disabled={from <= today || state.loading} onClick={() => setFrom(shiftDate(from, -7))} aria-label="Semana anterior">
          <ChevronLeft className="size-4" aria-hidden />
        </Button>
        <span className="text-muted-foreground text-sm">
          {fmtDay(from)} – {fmtDay(shiftDate(from, 6))}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={state.loading || shiftDate(from, 7) > shiftDate(today, page.rules.max_days_ahead)}
          onClick={() => setFrom(shiftDate(from, 7))}
          aria-label="Próxima semana"
        >
          <ChevronRight className="size-4" aria-hidden />
        </Button>
      </div>
      {state.loading ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Carregando horários…
        </p>
      ) : state.error ? (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : days.length === 0 ? (
        <p className="text-muted-foreground text-sm">Sem horários livres nesta semana. Veja a próxima.</p>
      ) : (
        <>
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Dias">
            {days.map((d) => (
              <button
                key={d.date}
                type="button"
                role="tab"
                aria-selected={current?.date === d.date}
                onClick={() => setDay(d.date)}
                className={`shrink-0 rounded-xl border px-3 py-2 text-sm capitalize ${current?.date === d.date ? 'border-primary bg-primary text-primary-foreground' : ''}`}
              >
                {fmtDay(d.date)}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {current?.slots.map((s) => (
              <Button key={s.starts_at} variant="outline" disabled={disabled} onClick={() => onPick(s)}>
                {fmtTime(s.starts_at, page.timezone)}
              </Button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ------------------------------------------------------------
// How to sign in: Google, e-mail code, or WhatsApp (phone confirmed)
// ------------------------------------------------------------

function SignIn({
  page,
  summary,
  onLeaveForGoogle,
  onSignedIn,
}: {
  page: PublicPage
  summary: string
  onLeaveForGoogle: () => void
  onSignedIn: (info: SessionInfo) => void
}) {
  const [mode, setMode] = useState<'choose' | 'email' | 'whatsapp'>(
    page.login.google || page.login.email ? 'choose' : 'whatsapp',
  )

  if (mode === 'whatsapp') {
    return (
      <div className="flex flex-col gap-3">
        {(page.login.google || page.login.email) && (
          <button type="button" onClick={() => setMode('choose')} className="text-muted-foreground w-fit text-sm underline underline-offset-4">
            Outras formas de entrar
          </button>
        )}
        <ConfirmPhone page={page} summary={summary} onConfirmed={() => onSignedIn({ kind: 'whatsapp', needs_phone: false, name: null })} />
      </div>
    )
  }
  if (mode === 'email') {
    return <EmailLogin page={page} onBack={() => setMode('choose')} onSignedIn={onSignedIn} />
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="bg-muted rounded-xl p-3 text-sm">
        <CalendarCheck className="mr-1 inline size-4 align-[-2px]" aria-hidden /> {summary}
      </div>
      <h2 className="text-base font-semibold">Como você quer continuar?</h2>
      {page.login.google && (
        <a
          href={`/api/agendar/google/iniciar?pagina=${encodeURIComponent(page.slug)}`}
          onClick={onLeaveForGoogle}
          className={buttonVariants({ variant: 'outline', size: 'lg' }) + ' gap-2'}
        >
          <GoogleMark /> Continuar com Google
        </a>
      )}
      {page.login.email && (
        <Button variant="outline" size="lg" onClick={() => setMode('email')}>
          <Mail className="size-5" aria-hidden /> Continuar com e-mail
        </Button>
      )}
      <Button variant="outline" size="lg" onClick={() => setMode('whatsapp')}>
        <MessageCircle className="size-5" aria-hidden /> Confirmar pelo WhatsApp
      </Button>
    </div>
  )
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden>
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.7z" />
      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.3a12 12 0 0 0 0 10.8l4-3.1z" />
      <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z" />
    </svg>
  )
}

function EmailLogin({ page, onBack, onSignedIn }: { page: PublicPage; onBack: () => void; onSignedIn: (info: SessionInfo) => void }) {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = async (e: { preventDefault: () => void }) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const r = await api<{ ok: boolean }>(page.slug, '/email', { method: 'POST', body: JSON.stringify({ email }) })
    setBusy(false)
    if (!r.ok) return setError(r.data.error ?? 'Não foi possível enviar o código.')
    setSent(true)
  }

  const verify = async (e: { preventDefault: () => void }) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const r = await api<{ ok: boolean; session: SessionInfo | null }>(page.slug, '/email/verificar', {
      method: 'POST',
      body: JSON.stringify({ codigo: code }),
    })
    setBusy(false)
    if (r.ok && r.data.session) return onSignedIn(r.data.session)
    setError(r.data.error ?? 'Não foi possível confirmar o código.')
    if (r.data.reason === 'expired') {
      setSent(false)
      setCode('')
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <button type="button" onClick={onBack} className="text-muted-foreground w-fit text-sm underline underline-offset-4">
        Outras formas de entrar
      </button>
      {!sent ? (
        <form onSubmit={send} className="flex flex-col gap-4">
          <h2 className="text-base font-semibold">Entrar com e-mail</h2>
          <label className="flex flex-col gap-1.5 text-sm">
            Seu e-mail
            <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" inputMode="email" autoComplete="email" maxLength={254} required />
          </label>
          <p className="text-muted-foreground text-xs">Vamos mandar um código de 6 números. Usamos seu e-mail só para você entrar aqui.</p>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <Button type="submit" size="lg" disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden />} Enviar código
          </Button>
        </form>
      ) : (
        <form onSubmit={verify} className="flex flex-col gap-4">
          <h2 className="text-base font-semibold">Digite o código</h2>
          <p className="text-muted-foreground text-sm">
            Enviamos um código para <span className="text-foreground">{email}</span>. Ele vale por 10 minutos.
          </p>
          <label className="flex flex-col gap-1.5 text-sm">
            Código
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              required
            />
          </label>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <Button type="submit" size="lg" disabled={busy || code.length !== 6}>
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden />} Entrar
          </Button>
          <button
            type="button"
            onClick={() => {
              setSent(false)
              setCode('')
              setError(null)
            }}
            className="text-muted-foreground w-fit text-xs underline underline-offset-4">
            Usar outro e-mail ou pedir novo código
          </button>
        </form>
      )}
    </div>
  )
}

/** E-mail / Google customers, first booking: name + phone for the reminders (not confirmed). */
function Details({
  page,
  summary,
  initialName,
  busy,
  error,
  onSubmit,
}: {
  page: PublicPage
  summary: string
  initialName: string
  busy: boolean
  error: string | null
  onSubmit: (d: { nome: string; celular: string; aceite: boolean }) => void
}) {
  const [name, setName] = useState(initialName)
  const [phone, setPhone] = useState('')
  const [accept, setAccept] = useState(false)
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit({ nome: name, celular: phone, aceite: accept })
      }}
      className="flex flex-col gap-4"
    >
      <div className="bg-muted rounded-xl p-3 text-sm">
        <CalendarCheck className="mr-1 inline size-4 align-[-2px]" aria-hidden /> {summary}
      </div>
      <h2 className="text-base font-semibold">Seus dados</h2>
      <label className="flex flex-col gap-1.5 text-sm">
        Nome
        <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} required />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        Celular com DDD (para os lembretes)
        <Input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="(11) 98765-4321"
          maxLength={30}
          required
        />
      </label>
      <label className="text-muted-foreground flex items-start gap-2 text-xs">
        <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} className="mt-0.5 size-4" required />
        <span>
          Autorizo {page.name} a usar meu nome e celular somente para este agendamento e para os lembretes pelo WhatsApp. Não informe dados de
          saúde aqui.
        </span>
      </label>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" disabled={busy || !accept}>
        {busy && <Loader2 className="size-4 animate-spin" aria-hidden />} Agendar
      </Button>
    </form>
  )
}

// ------------------------------------------------------------
// Phone check
// ------------------------------------------------------------

function ConfirmPhone({ page, summary, onConfirmed }: { page: PublicPage; summary: string; onConfirmed: () => void }) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [accept, setAccept] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [check, setCheck] = useState<{ code: string; url: string } | null>(null)

  const confirmedRef = useRef(onConfirmed)
  useEffect(() => {
    confirmedRef.current = onConfirmed
  }, [onConfirmed])

  useEffect(() => {
    if (!check) return
    let alive = true
    let running = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const started = Date.now()
    const tick = async () => {
      if (!alive || running) return
      running = true
      clearTimeout(timer)
      const r = await api<{ status: string }>(page.slug, '/confirmar')
      running = false
      if (!alive) return
      if (r.data.status === 'confirmed') return confirmedRef.current()
      if (r.data.status === 'expired' || Date.now() - started > 11 * 60_000) {
        setCheck(null)
        setError('O código venceu. Peça um novo para continuar.')
        return
      }
      // No connection / over the limit: keep waiting. 3 s for the first minute, then 5 s.
      timer = setTimeout(tick, Date.now() - started < 60_000 ? 3000 : 5000)
    }
    // Phones freeze timers while WhatsApp is in front: check as soon as the customer comes back.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    timer = setTimeout(tick, 3000)
    return () => {
      alive = false
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [check, page.slug])

  const start = async (e: { preventDefault: () => void }) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const r = await api<{ code: string; whatsapp_url: string }>(page.slug, '/confirmar', {
      method: 'POST',
      body: JSON.stringify({ nome: name, celular: phone, aceite: accept }),
    })
    setBusy(false)
    if (!r.ok) return setError(r.data.error ?? 'Não foi possível continuar.')
    setCheck({ code: r.data.code, url: r.data.whatsapp_url })
  }

  if (check) {
    return (
      <div className="flex flex-col gap-4 rounded-2xl border p-5">
        <h2 className="text-base font-semibold">Confirme pelo WhatsApp</h2>
        <p className="text-muted-foreground text-sm">
          Toque no botão abaixo e <strong className="text-foreground">envie a mensagem</strong> que vai aparecer pronta no WhatsApp. Use o mesmo
          celular que você informou.
        </p>
        <a href={check.url} target="_blank" rel="noopener noreferrer" className={buttonVariants({ size: 'lg' }) + ' gap-2'}>
          <MessageCircle className="size-5" aria-hidden /> Abrir o WhatsApp
        </a>
        <p className="text-muted-foreground text-center text-xs">
          Ou envie para a empresa: <span className="text-foreground font-mono">Código de agendamento: {check.code}</span>
        </p>
        <p className="text-muted-foreground flex items-center justify-center gap-2 text-sm" aria-live="polite">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Aguardando sua mensagem…
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={start} className="flex flex-col gap-4">
      <div className="bg-muted rounded-xl p-3 text-sm">
        <CalendarCheck className="mr-1 inline size-4 align-[-2px]" aria-hidden /> {summary}
      </div>
      <h2 className="text-base font-semibold">Seus dados</h2>
      <label className="flex flex-col gap-1.5 text-sm">
        Nome
        <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} required />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        Celular com DDD (WhatsApp)
        <Input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="(11) 98765-4321"
          maxLength={30}
          required
        />
      </label>
      <label className="text-muted-foreground flex items-start gap-2 text-xs">
        <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} className="mt-0.5 size-4" required />
        <span>
          Autorizo {page.name} a usar meu nome e celular somente para este agendamento e para os lembretes pelo WhatsApp. Não peça nem informe
          dados de saúde aqui.
        </span>
      </label>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" disabled={busy || !accept}>
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <MessageCircle className="size-5" aria-hidden />} Confirmar pelo
        WhatsApp
      </Button>
      <p className="text-muted-foreground text-xs">Você confirma uma vez; este aparelho fica lembrado por 30 dias.</p>
    </form>
  )
}

// ------------------------------------------------------------
// My appointments
// ------------------------------------------------------------

function Mine({ page, signedIn, onSignedOut, onBook }: { page: PublicPage; signedIn: boolean; onSignedOut: () => void; onBook: () => void }) {
  const [items, setItems] = useState<MyAppointment[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [moving, setMoving] = useState<MyAppointment | null>(null)
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [alternatives, setAlternatives] = useState<Slot[]>([])

  const [version, setVersion] = useState(0)
  const load = useCallback(() => setVersion((v) => v + 1), [])

  useEffect(() => {
    if (!signedIn) return
    let alive = true
    api<{ appointments: MyAppointment[] }>(page.slug, '/meus').then((r) => {
      if (!alive) return
      if (r.data.signed_out) return onSignedOut()
      setItems(r.ok ? r.data.appointments : [])
      setError(r.ok ? null : (r.data.error ?? 'Não foi possível carregar.'))
    })
    return () => {
      alive = false
    }
  }, [onSignedOut, page.slug, signedIn, version])

  if (!signedIn) {
    return (
      <div className="text-muted-foreground rounded-xl border p-4 text-sm">
        Para ver seus horários, faça um agendamento e confirme seu celular pelo WhatsApp neste aparelho.
        <Button className="mt-3 w-full" variant="outline" onClick={onBook}>
          Agendar
        </Button>
      </div>
    )
  }

  const act = async (id: string, body: object) => {
    setBusy(true)
    setError(null)
    const r = await api<{ ok: boolean }>(page.slug, `/meus/${id}`, { method: 'POST', body: JSON.stringify(body) })
    setBusy(false)
    if (r.data.signed_out) return onSignedOut()
    if (!r.ok) {
      setError(r.data.error ?? 'Não foi possível concluir.')
      setAlternatives(r.data.alternatives ?? [])
      return false
    }
    setAlternatives([])
    setMoving(null)
    setConfirmCancel(null)
    load()
    return true
  }

  if (moving) {
    return (
      <section className="flex flex-col gap-4">
        <button
          type="button"
          onClick={() => {
            setMoving(null)
            setError(null)
            setAlternatives([])
          }}
          className="text-muted-foreground flex w-fit items-center gap-1 text-sm">
          <ArrowLeft className="size-4" aria-hidden /> Voltar
        </button>
        <h2 className="text-base font-semibold">Novo horário para {moving.service}</h2>
        <p className="text-muted-foreground -mt-2 text-sm">Hoje: {fmtWhen(moving.starts_at, page.timezone)}</p>
        {error && (
          <p role="alert" className="bg-destructive/10 text-destructive rounded-xl p-3 text-sm">
            {error}
          </p>
        )}
        {alternatives.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {alternatives.map((s) => (
              <Button key={s.starts_at} variant="outline" size="sm" disabled={busy} onClick={() => void act(moving.id, { acao: 'remarcar', inicio: s.starts_at })}>
                {fmtDay(todayIn(page.timezone, new Date(s.starts_at)))} {fmtTime(s.starts_at, page.timezone)}
              </Button>
            ))}
          </div>
        )}
        <SlotPicker
          page={page}
          serviceId={moving.service_id}
          resourceId={moving.resource_id}
          disabled={busy}
          onPick={(s) => void act(moving.id, { acao: 'remarcar', inicio: s.starts_at })}
        />
      </section>
    )
  }

  return (
    <section className="flex flex-col gap-3">
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      {items === null ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Carregando…
        </p>
      ) : items.length === 0 ? (
        <div className="text-muted-foreground rounded-xl border p-4 text-sm">
          Você não tem horários marcados.
          <Button className="mt-3 w-full" variant="outline" onClick={onBook}>
            Agendar
          </Button>
        </div>
      ) : (
        items.map((a) => (
          <article key={a.id} className="flex flex-col gap-2 rounded-xl border p-4">
            <div>
              <h3 className="font-medium">{a.service}</h3>
              <p className="text-sm first-letter:uppercase">{fmtWhen(a.starts_at, page.timezone)}</p>
              {a.professional && <p className="text-muted-foreground text-sm">com {a.professional}</p>}
              {a.status === 'confirmed' && <p className="text-primary mt-1 text-xs font-medium">Confirmado</p>}
            </div>
            {confirmCancel === a.id ? (
              <div className="flex gap-2">
                <Button variant="destructive" size="sm" disabled={busy} onClick={() => void act(a.id, { acao: 'cancelar' })}>
                  Sim, cancelar
                </Button>
                <Button variant="outline" size="sm" onClick={() => setConfirmCancel(null)}>
                  Manter
                </Button>
              </div>
            ) : a.can_cancel || a.can_reschedule ? (
              <div className="flex gap-2">
                {a.can_reschedule && (
                  <Button variant="outline" size="sm" onClick={() => setMoving(a)}>
                    Remarcar
                  </Button>
                )}
                {a.can_cancel && (
                  <Button variant="ghost" size="sm" onClick={() => setConfirmCancel(a.id)}>
                    Cancelar
                  </Button>
                )}
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">Para mudar este horário, fale com a empresa.</p>
            )}
          </article>
        ))
      )}
      {page.rules.change_limit_hours > 0 && (page.rules.allow_cancel || page.rules.allow_reschedule) && (
        <p className="text-muted-foreground text-xs">Mudanças por aqui até {page.rules.change_limit_hours} h antes do horário.</p>
      )}
      <button
        type="button"
        className="text-muted-foreground mt-2 w-fit text-xs underline underline-offset-4"
        onClick={() => void api(page.slug, '/meus', { method: 'DELETE' }).then(() => onSignedOut())}
      >
        Sair de todos os aparelhos
      </button>
    </section>
  )
}

// ------------------------------------------------------------
// Install
// ------------------------------------------------------------

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
}

type InstallKind = 'none' | 'ios' | 'android'

function installKind(): InstallKind {
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
  if (standalone) return 'none'
  const ua = navigator.userAgent
  if (/iPhone|iPad|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1)) return 'ios'
  return (window as unknown as Record<string, unknown>)[INSTALL_PROMPT_KEY] ? 'android' : 'none'
}

function subscribeInstall(onChange: () => void): () => void {
  window.addEventListener(INSTALL_PROMPT_EVENT, onChange)
  return () => window.removeEventListener(INSTALL_PROMPT_EVENT, onChange)
}

function InstallHint({ name }: { name: string }) {
  // Android: the root layout parks `beforeinstallprompt` on window and fires INSTALL_PROMPT_EVENT.
  const kind = useSyncExternalStore(subscribeInstall, installKind, () => 'none' as InstallKind)

  if (kind === 'none') return null
  const prompt = () => (window as unknown as Record<string, InstallPromptEvent | undefined>)[INSTALL_PROMPT_KEY]?.prompt()
  return (
    <aside className="bg-muted mt-8 rounded-xl p-4 text-sm">
      <p className="font-medium">Tenha {name} na tela do celular</p>
      {kind === 'ios' ? (
        <p className="text-muted-foreground mt-1">
          No Safari, toque em <Share className="inline size-4 align-[-3px]" aria-label="Compartilhar" /> <strong>Compartilhar</strong> e depois em{' '}
          <strong>Adicionar à Tela de Início</strong>.
        </p>
      ) : (
        <Button className="mt-2" variant="outline" size="sm" onClick={() => void prompt()}>
          Instalar o app
        </Button>
      )}
    </aside>
  )
}
