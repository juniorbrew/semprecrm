'use client'

// The customer side of the booking page (migration 114): pick a service, a
// professional (or anyone), a free time; confirm the phone once on WhatsApp;
// book; see / cancel / move upcoming appointments. Talks only to
// /api/agendar/<slug>/*; the session lives in an HttpOnly cookie there.
// Customer-facing, Brazil only: pt-BR text, no app i18n.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowLeft, CalendarCheck, Check, ChevronLeft, ChevronRight, Clock, Loader2, MessageCircle, Share, User } from 'lucide-react'

import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatDuration, formatPrice, groupSlotsByDay, shiftDate, todayIn } from '@/lib/agenda/ui'
import type { Slot } from '@/lib/agenda/types'
import type { MyAppointment, PublicPage, PublicService } from '@/lib/booking-page/server'
import { INSTALL_PROMPT_EVENT, INSTALL_PROMPT_KEY } from '@/lib/pwa/install-prompt'

type Step = 'service' | 'professional' | 'time' | 'confirm' | 'done'

interface ApiError {
  error?: string
  signed_out?: boolean
  alternatives?: Slot[]
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

export function BookingApp({ page }: { page: PublicPage }) {
  const [tab, setTab] = useState<'book' | 'mine'>('book')
  const [signedIn, setSignedIn] = useState(false)

  const [checked, setChecked] = useState(false)
  useEffect(() => {
    api<{ signed_in: boolean }>(page.slug, '').then((r) => {
      setSignedIn(!!r.data.signed_in)
      setChecked(true)
    })
  }, [page.slug])
  const onSignedIn = useCallback(() => setSignedIn(true), [])
  const onSignedOut = useCallback(() => setSignedIn(false), [])
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
            <BookFlow page={page} signedIn={signedIn} onSignedIn={onSignedIn} onSeeMine={seeMine} />
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

function BookFlow({
  page,
  signedIn,
  onSignedIn,
  onSeeMine,
}: {
  page: PublicPage
  signedIn: boolean
  onSignedIn: () => void
  onSeeMine: () => void
}) {
  const [step, setStep] = useState<Step>('service')
  const [service, setService] = useState<PublicService | null>(null)
  const [resourceId, setResourceId] = useState<string | null>(null)
  const [slot, setSlot] = useState<Slot | null>(null)
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
    async (chosen: Slot) => {
      if (!service || inFlight.current) return
      if (keyRef.current?.startsAt !== chosen.starts_at) keyRef.current = { startsAt: chosen.starts_at, key: crypto.randomUUID() }
      inFlight.current = true
      setBusy(true)
      setError(null)
      setAlternatives([])
      const r = await api<{ ok: boolean; starts_at: string }>(page.slug, '/agendar', {
        method: 'POST',
        body: JSON.stringify({ servico: service.id, profissional: resourceId, inicio: chosen.starts_at, chave: keyRef.current.key }),
      })
      inFlight.current = false
      setBusy(false)
      if (r.ok) {
        setBooked({ starts_at: r.data.starts_at })
        setStep('done')
        return
      }
      if (r.data.signed_out) {
        setStep('confirm')
        return
      }
      // A definitive refusal: the next attempt at this slot is a new booking.
      if (r.status >= 400 && r.status < 500) keyRef.current = null
      setError(r.data.error ?? 'Não foi possível agendar.')
      setAlternatives(r.data.alternatives ?? [])
      if (r.status === 409) setStep('time')
    },
    [page.slug, resourceId, service],
  )

  const pickSlot = (s: Slot) => {
    setSlot(s)
    setError(null)
    setAlternatives([])
    if (signedIn) void book(s)
    else setStep('confirm')
  }

  const back = () => {
    setError(null)
    setAlternatives([])
    setStep(step === 'confirm' ? 'time' : step === 'time' ? (pros.length > 1 ? 'professional' : 'service') : 'service')
  }

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
      {step !== 'service' && (
        <button type="button" onClick={back} className="text-muted-foreground flex w-fit items-center gap-1 text-sm">
          <ArrowLeft className="size-4" aria-hidden /> Voltar
        </button>
      )}

      {step === 'service' && (
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

      {step === 'professional' && service && (
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

      {step === 'time' && service && (
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

      {step === 'confirm' && service && slot && (
        <ConfirmPhone
          page={page}
          summary={`${service.name} — ${fmtWhen(slot.starts_at, page.timezone)}`}
          onConfirmed={() => {
            onSignedIn()
            setStep('time')
            void book(slot)
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
              <p className="text-sm capitalize">{fmtWhen(a.starts_at, page.timezone)}</p>
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
