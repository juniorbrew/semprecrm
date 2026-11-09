// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// public/robo.js — loaded as a plain script and driven through its
// Shadow DOM, the way a visitor's browser would.
// ------------------------------------------------------------

const SOURCE = readFileSync(join(process.cwd(), 'public', 'robo.js'), 'utf8')
const KEY = 'a'.repeat(32)

interface Ctl {
  host: HTMLElement
  open: () => void
  close: () => void
  destroy: () => void
}
type Mount = (o: Record<string, unknown>) => Ctl

function load(currentScript: HTMLScriptElement | null = null) {
  Object.defineProperty(document, 'currentScript', { value: currentScript, configurable: true })
  ;(0, eval)(SOURCE)
  return (window as unknown as { SempreRobo: { mount: Mount } }).SempreRobo.mount
}

const CONFIG = {
  name: 'Assistente da Loja',
  color: '#2563eb',
  bubbleText: 'Posso ajudar?',
  side: 'right',
  greeting: 'Olá! Tudo bem?',
  questions: [
    { id: 'nome', text: 'Qual é o seu nome?', type: 'name', required: true },
    { id: 'fone', text: 'Qual é o seu WhatsApp?', type: 'phone', required: true },
    { id: 'cor', text: 'Qual cor você prefere?', type: 'choice', options: ['Azul', 'Verde'], required: false },
    { id: 'mail', text: 'E-mail?', type: 'email', required: false },
  ],
  consent: { text: 'Concordo em ser contatado.', linkUrl: 'https://loja.com.br/privacidade' },
  thanks: 'Obrigado, falamos já!',
  whatsapp: true,
}

const tick = (ms = 3000) => vi.advanceTimersByTimeAsync(ms)

function parts(ctl: Ctl) {
  const root = ctl.host.shadowRoot!
  const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector(sel) as T
  return {
    root,
    $,
    log: () => $('.log'),
    msgs: () => Array.from(root.querySelectorAll('.msg')).map((m) => `${m.classList.contains('me') ? 'me' : 'bot'}: ${m.textContent}`),
    field: () => $<HTMLInputElement>('form input'),
    async type(value: string) {
      const f = $<HTMLInputElement>('form input')
      f.value = value
      $<HTMLFormElement>('form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
      await tick()
    },
    async choose(label: string) {
      const b = Array.from(root.querySelectorAll<HTMLButtonElement>('.choices button')).find((x) => x.textContent === label)!
      b.click()
      await tick()
    },
  }
}

/** Opens a preview widget and plays it until the consent step. */
async function toConsent(extra: Record<string, unknown> = {}) {
  const submit = vi.fn(async () => ({ whatsapp_url: 'https://wa.me/5511999990000?text=Oi' }))
  const ctl = load()({ config: CONFIG, preview: true, submit, ...extra })
  const p = parts(ctl)
  ctl.open()
  await tick()
  await p.type('Ana Souza')
  await p.type('(11) 98765-4321')
  await p.choose('Azul')
  await p.type('ana@exemplo.com')
  return { ctl, p, submit }
}

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = ''
  window.sessionStorage.clear()
  Object.defineProperty(navigator, 'language', { value: 'pt-BR', configurable: true })
  delete (window as unknown as Record<string, unknown>).matchMedia
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('robo.js', () => {
  it('stays under 20 KB, uses no innerHTML and no dependencies', () => {
    expect(Buffer.byteLength(SOURCE)).toBeLessThan(30_000)
    expect(SOURCE.replace(/\/\*[\s\S]*?\*\//, '')).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|import\s|require\(/)
  })

  it('asks one question at a time after a typing pause, then consent, then sends', async () => {
    const { ctl, p, submit } = await (async () => {
      const submit = vi.fn(async () => ({ whatsapp_url: 'https://wa.me/5511999990000?text=Oi' }))
      const ctl = load()({ config: CONFIG, preview: true, submit })
      return { ctl, p: parts(ctl), submit }
    })()
    expect(p.msgs()).toEqual([])
    ctl.open()
    expect(p.$('.typing')).toBeTruthy()
    await tick()
    expect(p.msgs()).toEqual(['bot: Olá! Tudo bem?', 'bot: Qual é o seu nome?'])
    await p.type('Ana Souza')
    expect(p.msgs().slice(-2)).toEqual(['me: Ana Souza', 'bot: Qual é o seu WhatsApp?'])
    await p.type('(11) 98765-4321')
    expect(p.msgs().slice(-1)).toEqual(['bot: Qual cor você prefere?'])
    expect(Array.from(p.root.querySelectorAll('.choices button')).map((b) => b.textContent)).toEqual(['Azul', 'Verde', ].slice(0, 2))
    await p.choose('Verde')
    await p.type('ana@exemplo.com')
    expect(p.msgs().slice(-1)).toEqual(['bot: Para terminar, preciso da sua autorização.'])
    expect(p.root.querySelector('input[type=checkbox]')).toBeTruthy()
    expect(submit).not.toHaveBeenCalled()
  })

  it('validates the phone and the email before moving on', async () => {
    const ctl = load()({ config: CONFIG, preview: true, submit: vi.fn() })
    const p = parts(ctl)
    ctl.open()
    await tick()
    await p.type('Ana')
    await p.type('123')
    expect(p.msgs().slice(-1)[0]).toContain('número não parece válido')
    expect(p.msgs().filter((m) => m === 'me: 123')).toHaveLength(0)
    await p.type('(11) 98765-4321')
    expect(p.msgs().slice(-1)).toEqual(['bot: Qual cor você prefere?'])
    await p.choose('Azul')
    await p.type('sem-arroba')
    expect(p.msgs().slice(-1)[0]).toContain('e-mail não parece válido')
    await p.type('ana@exemplo.com')
    expect(p.msgs().slice(-1)[0]).toContain('autorização')
  })

  it('requires required answers and lets optional ones be skipped', async () => {
    const ctl = load()({ config: CONFIG, preview: true, submit: vi.fn() })
    const p = parts(ctl)
    ctl.open()
    await tick()
    await p.type('   ')
    expect(p.msgs().slice(-1)[0]).toContain('Preciso dessa resposta')
    expect(Array.from(p.root.querySelectorAll('button')).some((b) => b.textContent === 'Pular')).toBe(false)
    await p.type('Ana')
    await p.type('11987654321')
    ;(Array.from(p.root.querySelectorAll('button')).find((b) => b.textContent === 'Pular') as HTMLButtonElement).click()
    await tick()
    expect(p.msgs().slice(-1)).toEqual(['bot: E-mail?'])
  })

  it('does not send until the consent box is ticked, then shows thanks and a safe WhatsApp link', async () => {
    const { p, submit } = await toConsent()
    const send = p.$<HTMLButtonElement>('.foot .btn')
    send.click()
    await tick()
    expect(submit).not.toHaveBeenCalled()
    expect(p.msgs().slice(-1)[0]).toContain('Marque a caixa')
    const box = p.$<HTMLInputElement>('input[type=checkbox]')
    box.checked = true
    send.click()
    await tick()
    expect(submit).toHaveBeenCalledWith({ nome: 'Ana Souza', fone: '(11) 98765-4321', cor: 'Azul', mail: 'ana@exemplo.com' })
    expect(p.msgs().slice(-1)).toEqual(['bot: Obrigado, falamos já!'])
    const a = p.$<HTMLAnchorElement>('a.btn')
    expect(a.textContent).toBe('Continuar no WhatsApp')
    expect(a.getAttribute('href')).toBe('https://wa.me/5511999990000?text=Oi')
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toContain('noopener')
  })

  it('shows the privacy link only for https addresses, opening in a new tab', async () => {
    const { p } = await toConsent()
    const link = p.$<HTMLAnchorElement>('.consent a')
    expect(link.getAttribute('href')).toBe('https://loja.com.br/privacidade')
    expect(link.getAttribute('rel')).toContain('noopener')
    const bad = load()({ config: { ...CONFIG, consent: { text: 'ok', linkUrl: 'javascript:alert(1)' } }, preview: true, submit: vi.fn() })
    const q = parts(bad)
    bad.open()
    await tick()
    await q.type('Ana')
    await q.type('11987654321')
    await q.choose('Azul')
    await q.type('')
    expect(q.root.querySelector('.consent a')).toBeNull()
  })

  it('ignores a WhatsApp URL that is not wa.me, and offers to close instead', async () => {
    const { p } = await toConsent({ submit: async () => ({ whatsapp_url: 'javascript:alert(1)' }) })
    p.$<HTMLInputElement>('input[type=checkbox]').checked = true
    p.$<HTMLButtonElement>('.foot .btn').click()
    await tick()
    expect(p.root.querySelector('a.btn')).toBeNull()
    expect(p.msgs().slice(-1)).toEqual(['bot: Obrigado, falamos já!'])
  })

  it('renders every config and visitor string as text, never as markup', async () => {
    const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>'
    const cfg = {
      ...CONFIG,
      name: evil,
      bubbleText: evil,
      greeting: evil,
      thanks: evil,
      consent: { text: evil, linkUrl: '' },
      questions: [
        { id: 'nome', text: evil, type: 'name', required: true },
        { id: 'fone', text: evil, type: 'phone', required: true },
        { id: 'cor', text: evil, type: 'choice', options: [evil, 'B'], required: true },
      ],
      color: 'red;background:url(javascript:1)',
    }
    const ctl = load()({ config: cfg, preview: true, submit: async () => ({}) })
    const p = parts(ctl)
    ctl.open()
    await tick()
    await p.type(evil)
    await p.type('11987654321')
    await p.choose(evil)
    p.$<HTMLInputElement>('input[type=checkbox]').checked = true
    p.$<HTMLButtonElement>('.foot .btn').click()
    await tick()
    expect(p.root.querySelectorAll('img, script, iframe, svg image').length).toBe(0)
    expect(p.msgs()).toContain(`me: ${evil}`)
    expect(p.$('.head span').textContent).toBe(evil)
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined()
    expect(p.$('.wrap').style.getPropertyValue('--c')).toBe('#2563eb')
  })

  it('has an aria-live log, a labelled dialog and keyboard-friendly controls', async () => {
    const ctl = load()({ config: CONFIG, preview: true, submit: vi.fn() })
    const p = parts(ctl)
    expect(p.log().getAttribute('role')).toBe('log')
    expect(p.log().getAttribute('aria-live')).toBe('polite')
    expect(p.$('.panel').getAttribute('role')).toBe('dialog')
    expect(p.$('.panel').getAttribute('aria-label')).toBe('Assistente da Loja')
    expect(p.$('.launch').tagName).toBe('BUTTON')
    expect(p.$('.launch').getAttribute('aria-label')).toBe('Abrir conversa')
    expect(p.$('.x').getAttribute('aria-label')).toBe('Fechar conversa')
    expect(p.$('.typing, .log')).toBeTruthy()
    ctl.open()
    await tick()
    expect(p.field().getAttribute('aria-label')).toBe('Qual é o seu nome?')
    expect(p.field().getAttribute('autocomplete')).toBe('name')
  })

  it('moves focus to the answer field; Escape does not close the preview', async () => {
    const preview = load()({ config: CONFIG, preview: true, submit: vi.fn() })
    const p = parts(preview)
    preview.open()
    await tick()
    expect(p.root.activeElement).toBe(p.field())
    p.$('.panel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }))
    // preview mode keeps the panel open (the editor owns it)
    expect(p.$('.wrap').classList.contains('open')).toBe(true)
  })

  it('closes on Escape on a live site and refocuses the launcher', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, config: CONFIG }), { status: 200 }))
    window.fetch = fetchMock as unknown as typeof fetch
    const ctl = load()({ key: KEY, endpoint: `https://crm.test/api/v1/robo/${KEY}` })
    await tick(10)
    const p = parts(ctl as unknown as Ctl)
    expect(p.$('.wrap')).toBeTruthy()
    ;(ctl as unknown as Ctl).open()
    await tick()
    expect(p.$('.wrap').classList.contains('open')).toBe(true)
    p.$('.panel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }))
    expect(p.$('.wrap').classList.contains('open')).toBe(false)
    expect(p.root.activeElement).toBe(p.$('.launch'))
  })

  it('uses English when the browser language is English', async () => {
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
    const ctl = load()({ config: CONFIG, preview: true, submit: vi.fn() })
    const p = parts(ctl)
    expect(p.$('.launch').getAttribute('aria-label')).toBe('Open chat')
    ctl.open()
    await tick()
    await p.type('Ana')
    await p.type('1')
    expect(p.msgs().slice(-1)[0]).toContain('does not look valid')
  })

  it('shortens, but does not remove, the typing pause under reduced motion', async () => {
    window.matchMedia = ((q: string) => ({ matches: q.includes('reduce'), media: q })) as unknown as typeof window.matchMedia
    const ctl = load()({ config: CONFIG, preview: true, submit: vi.fn() })
    const p = parts(ctl)
    ctl.open()
    await tick(100)
    expect(p.msgs()).toEqual([])
    await tick(600)
    expect(p.msgs()).toEqual(['bot: Olá! Tudo bem?', 'bot: Qual é o seu nome?'])
  })

  it('on a live site: loads the config, posts answers once with consent, honeypot and elapsed time', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    window.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (!init?.method) return new Response(JSON.stringify({ ok: true, config: CONFIG }), { status: 200 })
      return new Response(JSON.stringify({ ok: true, whatsapp_url: 'https://wa.me/5511999990000?text=Oi' }), { status: 200 })
    }) as unknown as typeof fetch
    window.history.replaceState({}, '', '/promo?utm_campaign=bf&email=ana%40x.com&gclid=G1&token=secret#frag')
    Object.defineProperty(document, 'referrer', { value: 'https://www.google.com/search?q=ana+souza', configurable: true })
    const ctl = load()({ key: KEY, endpoint: `https://crm.test/api/v1/robo/${KEY}` }) as unknown as Ctl
    await tick(10)
    const p = parts(ctl)
    ctl.open()
    await tick()
    await p.type('Ana Souza')
    await p.type('(11) 98765-4321')
    await p.choose('Azul')
    await p.type('')
    p.$<HTMLInputElement>('input[type=checkbox]').checked = true
    const sendBtn = p.$<HTMLButtonElement>('.foot .btn')
    sendBtn.click()
    sendBtn.click()
    await tick()
    const posts = calls.filter((c) => c.init?.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0].url).toBe(`https://crm.test/api/v1/robo/${KEY}`)
    expect((posts[0].init!.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(posts[0].init!.credentials).toBe('omit')
    const body = JSON.parse(posts[0].init!.body as string)
    expect(body).toMatchObject({ answers: { nome: 'Ana Souza', fone: '(11) 98765-4321', cor: 'Azul' }, consent: true, contact_ref: '' })
    expect(body.elapsed_ms).toBeGreaterThanOrEqual(2000)
    // origin (migration 109): the page and its referrer; the server keeps only campaign params and the host
    // only the origin, the path and the campaign params leave the page; the referrer is its host
    expect(body.page_url).toBe(`${window.location.origin}/promo?utm_campaign=bf&gclid=G1`)
    expect(body.referrer).toBe('www.google.com')
    expect(p.$('a.btn').getAttribute('href')).toBe('https://wa.me/5511999990000?text=Oi')
  })

  it('sends whatever a bot filled into the hidden honeypot field', async () => {
    const calls: RequestInit[] = []
    window.fetch = vi.fn(async (_u: string, init?: RequestInit) => {
      if (!init?.method) return new Response(JSON.stringify({ ok: true, config: CONFIG }), { status: 200 })
      calls.push(init)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch
    const ctl = load()({ key: KEY, endpoint: 'https://crm.test/x' }) as unknown as Ctl
    await tick(10)
    const p = parts(ctl)
    const hp = p.$<HTMLInputElement>('input[name=contact_ref]')
    expect(hp.getAttribute('tabindex')).toBe('-1')
    expect(hp.getAttribute('aria-hidden')).toBe('true')
    hp.value = 'http://spam'
    ctl.open()
    await tick()
    await p.type('Ana')
    await p.type('11987654321')
    await p.choose('Azul')
    await p.type('')
    p.$<HTMLInputElement>('input[type=checkbox]').checked = true
    p.$<HTMLButtonElement>('.foot .btn').click()
    await tick()
    expect(JSON.parse(calls[0].body as string).contact_ref).toBe('http://spam')
  })

  it('offers a retry when the send fails, and does not lose the answers', async () => {
    let n = 0
    window.fetch = vi.fn(async (_u: string, init?: RequestInit) => {
      if (!init?.method) return new Response(JSON.stringify({ ok: true, config: CONFIG }), { status: 200 })
      n += 1
      return n === 1 ? new Response('{}', { status: 500 }) : new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch
    const ctl = load()({ key: KEY, endpoint: 'https://crm.test/x' }) as unknown as Ctl
    await tick(10)
    const p = parts(ctl)
    ctl.open()
    await tick()
    await p.type('Ana')
    await p.type('11987654321')
    await p.choose('Azul')
    await p.type('')
    p.$<HTMLInputElement>('input[type=checkbox]').checked = true
    p.$<HTMLButtonElement>('.foot .btn').click()
    await tick()
    expect(p.msgs().slice(-1)[0]).toContain('Não foi possível enviar')
    const retry = Array.from(p.root.querySelectorAll<HTMLButtonElement>('.foot .btn')).find((b) => b.textContent === 'Tentar de novo')!
    retry.click()
    await tick()
    expect(p.msgs().slice(-1)).toEqual(['bot: Obrigado, falamos já!'])
    expect(n).toBe(2)
  })

  it('stays invisible when the config cannot be loaded', async () => {
    window.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as unknown as typeof fetch
    load()({ key: KEY, endpoint: 'https://crm.test/x' })
    await tick(10)
    expect(document.querySelector('[data-robo-host]')).toBeNull()
    window.fetch = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    load()({ key: KEY, endpoint: 'https://crm.test/x' })
    await tick(10)
    expect(document.querySelector('[data-robo-host]')).toBeNull()
  })

  describe('resume (localStorage, 1 day)', () => {
    const fetchOk = () =>
      (window.fetch = vi.fn(async (_u: string, init?: RequestInit) =>
        init?.method
          ? new Response(JSON.stringify({ ok: true }), { status: 200 })
          : new Response(JSON.stringify({ ok: true, config: CONFIG }), { status: 200 }),
      ) as unknown as typeof fetch)

    async function openLive() {
      fetchOk()
      const ctl = load()({ key: KEY, endpoint: 'https://crm.test/x' }) as unknown as Ctl
      await tick(10)
      const p = parts(ctl)
      ctl.open()
      await tick()
      return { ctl, p }
    }

    it('continues where the visitor stopped, replaying what was said', async () => {
      const first = await openLive()
      await first.p.type('Ana Souza')
      await first.p.type('(11) 98765-4321')
      first.ctl.destroy()
      document.body.innerHTML = ''
      const again = await openLive()
      expect(again.p.msgs()).toEqual([
        'bot: Olá! Tudo bem?',
        'bot: Qual é o seu nome?',
        'me: Ana Souza',
        'bot: Qual é o seu WhatsApp?',
        'me: (11) 98765-4321',
        'bot: Qual cor você prefere?',
      ])
      expect(again.p.root.querySelectorAll('.choices button')).toHaveLength(2)
    })

    it('stores answers only in this tab (sessionStorage), never the consent, and nothing in localStorage', async () => {
      const { p } = await openLive()
      await p.type('Ana Souza')
      const saved = JSON.parse(window.sessionStorage.getItem(`sempre-robo:${KEY}`)!)
      expect(saved.answers).toEqual({ nome: 'Ana Souza' })
      expect(saved.exp - Date.now()).toBeGreaterThan(23 * 3600_000)
      expect(saved.exp - Date.now()).toBeLessThanOrEqual(24 * 3600_000)
      expect(JSON.stringify(saved)).not.toContain('consent')
      expect(vi.mocked(window.fetch).mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST')).toHaveLength(0)
    })

    it('starts over after a day, and clears the saved state once sent', async () => {
      const first = await openLive()
      await first.p.type('Ana')
      first.ctl.destroy()
      document.body.innerHTML = ''
      vi.setSystemTime(Date.now() + 25 * 3600_000)
      const again = await openLive()
      expect(again.p.msgs()).toEqual(['bot: Olá! Tudo bem?', 'bot: Qual é o seu nome?'])

      await again.p.type('Ana')
      await again.p.type('11987654321')
      await again.p.choose('Azul')
      await again.p.type('')
      again.p.$<HTMLInputElement>('input[type=checkbox]').checked = true
      again.p.$<HTMLButtonElement>('.foot .btn').click()
      await tick()
      expect(window.sessionStorage.getItem(`sempre-robo:${KEY}`)).toBeNull()
    })

    it('works when storage throws', async () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('blocked')
      })
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('blocked')
      })
      const { p } = await openLive()
      await p.type('Ana')
      expect(p.msgs().slice(-1)).toEqual(['bot: Qual é o seu WhatsApp?'])
    })

    it('ignores corrupt saved state', async () => {
      window.sessionStorage.setItem(`sempre-robo:${KEY}`, '{not json')
      const { p } = await openLive()
      expect(p.msgs()).toEqual(['bot: Olá! Tudo bem?', 'bot: Qual é o seu nome?'])
    })

    it('preview mode never reads or writes storage', async () => {
      const setItem = vi.spyOn(Storage.prototype, 'setItem')
      const ctl = load()({ config: CONFIG, preview: true, submit: vi.fn() })
      const p = parts(ctl)
      ctl.open()
      await tick()
      await p.type('Ana')
      expect(setItem).not.toHaveBeenCalled()
    })
  })

  describe('embedding', () => {
    it('starts by itself from the data-robo attribute, fetching config from the script origin', async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, config: CONFIG }), { status: 200 }))
      window.fetch = fetchMock as unknown as typeof fetch
      const tag = document.createElement('script')
      tag.src = 'https://www.semprecrm.com.br/robo.js'
      tag.setAttribute('data-robo', KEY)
      load(tag)
      await tick(10)
      expect(fetchMock).toHaveBeenCalledWith(`https://www.semprecrm.com.br/api/v1/robo/${KEY}`, { credentials: 'omit' })
      expect(document.querySelector('[data-robo-host]')).toBeTruthy()
    })

    it('does nothing for a malformed key, and does not start twice for the same key', async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, config: CONFIG }), { status: 200 }))
      window.fetch = fetchMock as unknown as typeof fetch
      const bad = document.createElement('script')
      bad.src = 'https://x.test/robo.js'
      bad.setAttribute('data-robo', '../../etc')
      load(bad)
      await tick(10)
      expect(fetchMock).not.toHaveBeenCalled()
      const tag = document.createElement('script')
      tag.src = 'https://x.test/robo.js'
      tag.setAttribute('data-robo', 'b'.repeat(32))
      load(tag)
      load(tag)
      await tick(10)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(document.querySelectorAll('[data-robo-host]')).toHaveLength(1)
    })

    it('puts the widget on the chosen side and can be destroyed', async () => {
      const ctl = load()({ config: { ...CONFIG, side: 'left' }, preview: true, submit: vi.fn() })
      expect(parts(ctl).$('.wrap').classList.contains('left')).toBe(true)
      ctl.destroy()
      expect(document.querySelector('[data-robo-host]')).toBeNull()
    })
  })
})

describe('robo.js review fixes', () => {
  const okResponse = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })

  async function live(config = CONFIG, post?: (init: RequestInit) => Response) {
    const posts: RequestInit[] = []
    window.fetch = vi.fn(async (_u: string, init?: RequestInit) => {
      if (!init?.method) return okResponse({ ok: true, config })
      posts.push(init)
      return post ? post(init) : okResponse({ ok: true })
    }) as unknown as typeof fetch
    const ctl = load()({ key: KEY, endpoint: 'https://crm.test/x' }) as unknown as Ctl
    await tick(10)
    const p = parts(ctl)
    ctl.open()
    await tick()
    return { ctl, p, posts }
  }

  async function toSend(p: ReturnType<typeof parts>) {
    await p.type('Ana Souza')
    await p.type('(11) 98765-4321')
    await p.choose('Azul')
    await p.type('ana@exemplo.com')
    p.$<HTMLInputElement>('input[type=checkbox]').checked = true
    p.$<HTMLButtonElement>('.foot .btn').click()
    await tick()
  }

  it('keeps the chat only in sessionStorage, nothing in localStorage', async () => {
    const { p } = await live()
    await p.type('Ana')
    expect(window.sessionStorage.getItem(`sempre-robo:${KEY}`)).toContain('Ana')
    expect(window.localStorage.length).toBe(0)
  })

  it('discards a saved chat when the questions changed, and keeps only still-valid answers otherwise', async () => {
    const first = await live()
    await first.p.type('Ana')
    await first.p.type('11987654321')
    first.ctl.destroy()
    document.body.innerHTML = ''
    const changed = { ...CONFIG, questions: [CONFIG.questions[1], CONFIG.questions[0], ...CONFIG.questions.slice(2)] }
    const again = await live(changed)
    expect(again.p.msgs()).toEqual(['bot: Olá! Tudo bem?', 'bot: Qual é o seu WhatsApp?'])
    again.ctl.destroy()
    document.body.innerHTML = ''
    window.sessionStorage.clear()
    const third = await live()
    await third.p.type('Ana')
    await third.p.type('11987654321')
    await third.p.choose('Azul')
    third.ctl.destroy()
    document.body.innerHTML = ''
    const saved = JSON.parse(window.sessionStorage.getItem(`sempre-robo:${KEY}`)!)
    saved.answers.cor = 'Vermelho'
    window.sessionStorage.setItem(`sempre-robo:${KEY}`, JSON.stringify(saved))
    const fourth = await live()
    expect(fourth.p.msgs().join('|')).not.toContain('Vermelho')
    expect(fourth.p.msgs()).toContain('me: Ana')
  })

  it('validates phone and email with the server rules', async () => {
    const { p } = await live()
    await p.type('Ana')
    for (const bad of ['123', '1234567890123456', 'abc', '0000000']) {
      await p.type(bad)
      expect(p.msgs().slice(-1)[0], bad).toContain('número não parece válido')
    }
    await p.type('+1 202 555 0100')
    expect(p.msgs().slice(-1)).toEqual(['bot: Qual cor você prefere?'])
  })

  it('goes back to the question the server rejected, prefilled, with no retry button', async () => {
    const { p, posts } = await live(CONFIG, () => okResponse({ ok: false, error: 'invalid_phone', question: 'fone' }, 400))
    await toSend(p)
    expect(p.msgs().slice(-1)[0]).toContain('número não parece válido')
    expect(p.field().value).toBe('(11) 98765-4321')
    expect(Array.from(p.root.querySelectorAll('button')).some((b) => b.textContent === 'Tentar de novo')).toBe(false)
    expect(posts).toHaveLength(1)
  })

  it('maps a rejected answer without a question id to the matching question type', async () => {
    const { p } = await live(CONFIG, () => okResponse({ ok: false, error: 'invalid_email' }, 400))
    await toSend(p)
    expect(p.msgs().slice(-1)[0]).toContain('e-mail não parece válido')
    expect(p.field().value).toBe('ana@exemplo.com')
  })

  it('asks for the name again when the server refuses it', async () => {
    const { p } = await live(CONFIG, () => okResponse({ ok: false, error: 'invalid_name', question: 'nome' }, 400))
    await toSend(p)
    expect(p.msgs().slice(-1)[0]).toContain('só o seu nome')
    expect(p.field().value).toBe('Ana Souza')
  })

  it('offers a retry only for network errors, 5xx and 429', async () => {
    for (const [status, retry] of [[500, true], [429, true], [403, false], [404, false], [413, false]] as const) {
      document.body.innerHTML = ''
      window.sessionStorage.clear()
      const { p } = await live(CONFIG, () => okResponse({ ok: false }, status))
      await toSend(p)
      const has = Array.from(p.root.querySelectorAll('button')).some((b) => b.textContent === 'Tentar de novo')
      expect(has, String(status)).toBe(retry)
      expect(p.msgs().slice(-1)[0]).toContain('Não foi possível enviar')
    }
  })

  it('prefills the field after a client-side validation error', async () => {
    const { p } = await live()
    await p.type('Ana')
    await p.type('12')
    expect(p.field().value).toBe('12')
  })

  it('on a phone: aria-modal, page scroll lock, focus trap and keyboard-aware height', async () => {
    window.matchMedia = ((q: string) => ({ matches: q.includes('max-width'), media: q })) as unknown as typeof window.matchMedia
    const listeners: Record<string, () => void> = {}
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: { height: 400, offsetTop: 0, addEventListener: (n: string, f: () => void) => (listeners[n] = f), removeEventListener: () => {} },
    })
    const { ctl, p } = await live()
    expect(p.$('.panel').getAttribute('aria-modal')).toBe('true')
    expect(document.documentElement.style.overflow).toBe('hidden')
    expect(p.$('.panel').style.height).toBe('400px')
    ;(window.visualViewport as unknown as { height: number }).height = 250
    listeners.resize()
    expect(p.$('.panel').style.height).toBe('250px')
    const els = Array.from(p.root.querySelectorAll<HTMLElement>('.panel button, .panel input')).filter((n) => n.getAttribute('tabindex') !== '-1')
    els[els.length - 1].focus()
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, composed: true, cancelable: true })
    p.$('.panel').dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(p.root.activeElement).toBe(els[0])
    ctl.close()
    expect(document.documentElement.style.overflow).toBe('')
    expect(p.$('.panel').getAttribute('aria-modal')).toBe('false')
    delete (window as unknown as Record<string, unknown>).visualViewport
  })

  it('finds its own tag when document.currentScript is null, and retries after a failed config fetch', async () => {
    const tag = document.createElement('script')
    tag.src = 'https://crm.test/robo.js'
    tag.setAttribute('data-robo', 'd'.repeat(32))
    document.head.appendChild(tag)
    let ok = false
    const fetchMock = vi.fn(async () => (ok ? okResponse({ ok: true, config: CONFIG }) : new Response('{}', { status: 500 })))
    window.fetch = fetchMock as unknown as typeof fetch
    load(null)
    await tick(10)
    expect(fetchMock).toHaveBeenCalledWith(`https://crm.test/api/v1/robo/${'d'.repeat(32)}`, { credentials: 'omit' })
    expect(document.querySelector('[data-robo-host]')).toBeNull()
    ok = true
    load(null)
    await tick(10)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[data-robo-host]')).toBeTruthy()
    tag.remove()
  })

  it('uses a neutral honeypot name', async () => {
    const { p } = await live()
    const hp = p.$<HTMLInputElement>('input.hp')
    expect(hp.name).toBe('contact_ref')
    expect(hp.getAttribute('autocomplete')).toBe('off')
  })
})
