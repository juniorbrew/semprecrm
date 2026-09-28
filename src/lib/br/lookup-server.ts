// ============================================================
// Company / address lookup — server side.
//
// Talks to the public sources on behalf of the browser so the
// signup page (unauthenticated) never hits them directly: one
// place to rate-limit, to keep an in-memory cache (CNPJ data
// changes rarely; CEPs never) and to fall back between
// providers (CNPJ: BrasilAPI → CNPJ.ws → ReceitaWS; CEP: BrasilAPI
// raced against ViaCEP). Mapping lives in ./lookup (pure, tested).
//
// `fetchImpl` is injectable for tests; production uses the global.
// ============================================================

import {
  isValidCep,
  mapBrasilApiCep,
  mapBrasilApiCnpj,
  mapCnpjWs,
  mapReceitaWs,
  mapViaCep,
  normalizeCep,
  type AddressLookup,
  type CompanyLookup,
} from './lookup'
import { isValidCnpj, normalizeTaxId } from './documents'

export type LookupFailure = 'invalid' | 'not_found' | 'upstream_error'

export type CnpjLookupResult = { ok: true; company: CompanyLookup } | { ok: false; reason: LookupFailure }
export type CepLookupResult = { ok: true; address: AddressLookup } | { ok: false; reason: LookupFailure }

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

const UPSTREAM_TIMEOUT_MS = 6_000
const EMAIL_LOOKUP_TIMEOUT_MS = 2_500
const CNPJ_TTL_MS = 24 * 60 * 60 * 1000
const CEP_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_CACHE_ENTRIES = 5_000

const cache = new Map<string, { expires: number; value: unknown }>()

function cacheGet<T>(key: string): T | undefined {
  const hit = cache.get(key)
  if (!hit) return undefined
  if (hit.expires < Date.now()) {
    cache.delete(key)
    return undefined
  }
  return hit.value as T
}

function cacheSet(key: string, value: unknown, ttl: number) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    // Drop the oldest insertion — Map iterates in insertion order.
    const first = cache.keys().next().value
    if (first !== undefined) cache.delete(first)
  }
  cache.set(key, { expires: Date.now() + ttl, value })
}

/** Test-only: clear the shared cache between cases. */
export function __resetLookupCacheForTests() {
  cache.clear()
  cooldownUntil.clear()
}

// A source that answered 429 is left alone for a minute: the free tiers
// (cnpj.ws, ReceitaWS: ~3 calls/min) only get worse when hammered, and
// skipping them keeps the fallback fast. Per process, like the cache.
const RATE_LIMIT_COOLDOWN_MS = 60_000
const cooldownUntil = new Map<string, number>()

function hostOf(url: string): string {
  return new URL(url).host
}

function coolingDown(url: string): boolean {
  const until = cooldownUntil.get(hostOf(url))
  if (until === undefined) return false
  if (until <= Date.now()) {
    cooldownUntil.delete(hostOf(url))
    return false
  }
  return true
}

function noteStatus(url: string, status: number) {
  if (status === 429) cooldownUntil.set(hostOf(url), Date.now() + RATE_LIMIT_COOLDOWN_MS)
}

async function getJson(
  fetchImpl: FetchLike,
  url: string,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': 'SempreCRM/1.0 (+lookup)' },
      signal: controller.signal,
    })
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    return { status: res.status, json }
  } catch {
    return { status: 0, json: null }
  } finally {
    clearTimeout(timer)
  }
}

type CnpjSourceResult = { company: CompanyLookup } | { miss: true } | { failed: true }

/**
 * One public CNPJ source: GET, classify, map. 404/400 (or a 200 that
 * carries no company) is a miss; network errors, timeouts, 429 and
 * 5xx are failures — the next source gets its turn either way. A
 * source cooling down after a 429 counts as failed without a request.
 */
async function fromSource(
  fetchImpl: FetchLike,
  url: string,
  map: (json: Record<string, unknown>) => CompanyLookup | null,
): Promise<CnpjSourceResult> {
  if (coolingDown(url)) return { failed: true }
  const r = await getJson(fetchImpl, url)
  noteStatus(url, r.status)
  if (r.status === 404 || r.status === 400) return { miss: true }
  if (r.status !== 200) return { failed: true }
  if (!r.json) return { failed: true }
  const company = map(r.json)
  return company && company.legalName ? { company } : { miss: true }
}

/**
 * Three public, key-less sources in order — BrasilAPI, CNPJ.ws,
 * ReceitaWS. BrasilAPI is fastest but sometimes lags on newly opened
 * companies and throttles bursts; each source has its own base and
 * its own limits. A miss or an outage hands over to the next; the
 * answer is `not_found` only when some source said so and none found
 * it, `upstream_error` when every source failed.
 */
const CNPJ_SOURCES: { url: (cnpj: string) => string; map: (json: Record<string, unknown>, cnpj: string) => CompanyLookup | null }[] = [
  { url: (c) => `https://brasilapi.com.br/api/cnpj/v1/${c}`, map: (json) => mapBrasilApiCnpj(json) },
  { url: (c) => `https://publica.cnpj.ws/cnpj/${c}`, map: (json, c) => mapCnpjWs(json, c) },
  {
    url: (c) => `https://receitaws.com.br/v1/cnpj/${c}`,
    map: (json, c) => (json.status === 'ERROR' ? null : mapReceitaWs(json, c)),
  },
]

export interface LookupCnpjOptions {
  /**
   * When BrasilAPI answers without an e-mail, spend one cnpj.ws call to
   * fetch it (default true — signup / Settings). Skipped anyway while
   * cnpj.ws is cooling down after a 429.
   */
  enrichEmail?: boolean
}

export async function lookupCnpj(
  raw: string,
  fetchImpl: FetchLike = fetch,
  { enrichEmail = true }: LookupCnpjOptions = {},
): Promise<CnpjLookupResult> {
  const cnpj = normalizeTaxId(raw)
  if (!isValidCnpj(cnpj)) return { ok: false, reason: 'invalid' }

  const key = `cnpj:${cnpj}`
  const cached = cacheGet<CnpjLookupResult>(key)
  if (cached) return cached

  let missed = false
  let failed = false
  for (const [index, source] of CNPJ_SOURCES.entries()) {
    const r = await fromSource(fetchImpl, source.url(cnpj), (json) => source.map(json, cnpj))
    if ('miss' in r) {
      missed = true
      continue
    }
    if ('failed' in r) {
      failed = true
      continue
    }

    const company = r.company
    // BrasilAPI usually omits the e-mail the Receita holds; cnpj.ws has
    // it. Best effort, short budget, silently skipped when rate-limited
    // (its free tier allows 3 calls a minute).
    const enrichUrl = `https://publica.cnpj.ws/cnpj/${cnpj}`
    if (enrichEmail && index === 0 && !company.email && !coolingDown(enrichUrl)) {
      const extra = await getJson(fetchImpl, enrichUrl, EMAIL_LOOKUP_TIMEOUT_MS)
      noteStatus(enrichUrl, extra.status)
      const est = extra.status === 200 && extra.json ? (extra.json.estabelecimento as Record<string, unknown> | undefined) : undefined
      const email = typeof est?.email === 'string' ? est.email.trim().toLowerCase() : ''
      if (email) company.email = email
    }

    const hit: CnpjLookupResult = { ok: true, company }
    cacheSet(key, hit, CNPJ_TTL_MS)
    return hit
  }

  if (!missed) return { ok: false, reason: 'upstream_error' }
  const miss: CnpjLookupResult = { ok: false, reason: 'not_found' }
  // Only a unanimous miss is cached — a source that was down might
  // have had it.
  if (!failed) cacheSet(key, miss, CNPJ_TTL_MS)
  return miss
}

export async function lookupCep(
  raw: string,
  fetchImpl: FetchLike = fetch,
): Promise<CepLookupResult> {
  const cep = normalizeCep(raw)
  if (!isValidCep(cep)) return { ok: false, reason: 'invalid' }

  const key = `cep:${cep}`
  const cached = cacheGet<CepLookupResult>(key)
  if (cached) return cached

  // Race both providers and take the first usable answer — BrasilAPI is
  // usually ~100 ms but occasionally stalls for seconds, and ViaCEP is
  // steady; the user is waiting with a half-filled form.
  const brasilApi = getJson(fetchImpl, `https://brasilapi.com.br/api/cep/v2/${cep}`).then((r) => ({
    address: r.status === 200 && r.json ? mapBrasilApiCep(r.json) : null,
    missing: r.status === 404,
    failed: r.status === 0 || r.status >= 500,
  }))
  const viaCep = getJson(fetchImpl, `https://viacep.com.br/ws/${cep}/json/`).then((r) => {
    const mapped = r.status === 200 && r.json ? mapViaCep(r.json) : null
    return {
      address: mapped,
      missing: (r.status === 200 && r.json !== null && mapped === null) || r.status === 400,
      failed: r.status === 0 || r.status >= 500,
    }
  })

  const settled = await new Promise<{ address: AddressLookup | null; missing: boolean; failed: boolean }[]>((resolve) => {
    const results: { address: AddressLookup | null; missing: boolean; failed: boolean }[] = []
    let pending = 2
    const onDone = (r: { address: AddressLookup | null; missing: boolean; failed: boolean }) => {
      results.push(r)
      pending -= 1
      if ((r.address && r.address.city) || pending === 0) resolve(results)
    }
    void brasilApi.then(onDone)
    void viaCep.then(onDone)
  })

  const address = settled.find((r) => r.address && r.address.city)?.address ?? null
  const definitelyMissing = settled.some((r) => r.missing)
  const sawUpstreamError = settled.some((r) => r.failed)

  if (address && address.city) {
    const hit: CepLookupResult = { ok: true, address: { ...address, cep } }
    cacheSet(key, hit, CEP_TTL_MS)
    return hit
  }
  if (definitelyMissing || !sawUpstreamError) {
    const miss: CepLookupResult = { ok: false, reason: 'not_found' }
    cacheSet(key, miss, CEP_TTL_MS)
    return miss
  }
  return { ok: false, reason: 'upstream_error' }
}
