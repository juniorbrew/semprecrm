#!/usr/bin/env node
// ============================================================
// cron-tick — the internal scheduler (spec §4).
//
// Wait steps, time-based triggers, flow timeouts and the
// `conversation_inactive` follow-up only advance when something calls
// GET /api/automations/cron and GET /api/flows/cron. This script is that
// something, without depending on Vercel Cron or a system crontab:
// plain Node, no dependencies, one GET on each endpoint every
// CRON_INTERVAL_MS with the shared `x-cron-secret` header.
//
// The calendar sync (Google / Outlook, POST /api/integrations/calendar/sync)
// rides on the same loop but on its own, slower interval
// (CALENDAR_SYNC_INTERVAL_MS, default 5 min): it is called on the first
// tick and then whenever that much time has passed since its last call.
//
//   APP_URL                    base URL of the app  (default http://127.0.0.1:3100)
//   AUTOMATION_CRON_SECRET     must match the app's value (required)
//   CRON_INTERVAL_MS           tick interval in ms  (default 60000, min 5000)
//   CALENDAR_SYNC_INTERVAL_MS  calendar sync interval in ms (default 300000,
//                              min CRON_INTERVAL_MS)
//   CRON_HEALTH_PORT           optional: serve GET /health on this port so a
//                              process manager / launch config can probe it
//
// Local:  node --env-file=.env.local scripts/cron-tick.mjs
// VPS:    PM2 app `semprecrm-cron` in deploy/contabo/ecosystem.config.cjs
//
// One log line per call; network failures are logged and retried on the
// next tick; SIGTERM / SIGINT stop the loop cleanly.
// ============================================================

import http from 'node:http'

const APP_URL = (process.env.APP_URL || 'http://127.0.0.1:3100').replace(/\/+$/, '')
const SECRET = process.env.AUTOMATION_CRON_SECRET || ''
const INTERVAL_MS = Math.max(5_000, Number(process.env.CRON_INTERVAL_MS) || 60_000)
const CALENDAR_SYNC_INTERVAL_MS = Math.max(INTERVAL_MS, Number(process.env.CALENDAR_SYNC_INTERVAL_MS) || 300_000)
const HEALTH_PORT = Number(process.env.CRON_HEALTH_PORT) || 0
const REQUEST_TIMEOUT_MS = Math.min(INTERVAL_MS - 1_000, 55_000)

/**
 * { path, method, everyMs } — `everyMs` null = every tick; otherwise the
 * endpoint is called when at least that long has passed since its last
 * call (first tick included).
 */
const ENDPOINTS = [
  { path: '/api/automations/cron', method: 'GET', everyMs: null },
  { path: '/api/flows/cron', method: 'GET', everyMs: null },
  { path: '/api/integrations/calendar/sync', method: 'POST', everyMs: CALENDAR_SYNC_INTERVAL_MS },
]

function log(line) {
  process.stdout.write(`${new Date().toISOString()} [cron-tick] ${line}\n`)
}

if (!SECRET) {
  log('AUTOMATION_CRON_SECRET is not set — the endpoints would answer 401/503. Exiting.')
  process.exit(1)
}

let stopping = false
let ticking = false
let timer = null
const stats = { ticks: 0, ok: 0, failed: 0, lastTickAt: null, lastResults: {} }

/** Summarise the JSON the endpoints return ({ processed, inactivity, … }). */
function summarise(body) {
  if (!body || typeof body !== 'object') return ''
  const parts = []
  if ('processed' in body) parts.push(`processed=${body.processed}`)
  if (body.inactivity && typeof body.inactivity === 'object') {
    const i = body.inactivity
    parts.push(`inactive_fired=${i.fired ?? 0}`)
    if (i.skipped) parts.push(`inactive_skipped=${i.skipped}`)
    if (i.errors) parts.push(`inactive_errors=${i.errors}`)
  }
  if (body.lead_events_purged != null) parts.push(`lead_events_purged=${body.lead_events_purged}`)
  for (const k of ['advanced', 'timed_out', 'expired', 'runs', 'connections', 'synced', 'errors', 'revoked']) {
    if (k in body) parts.push(`${k}=${body[k]}`)
  }
  return parts.join(' ')
}

const lastCalledAt = new Map()

async function callEndpoint(path, method = 'GET') {
  const url = `${APP_URL}${path}`
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const started = Date.now()
  lastCalledAt.set(path, started)
  try {
    const res = await fetch(url, {
      method,
      headers: { 'x-cron-secret': SECRET, accept: 'application/json' },
      signal: controller.signal,
    })
    const ms = Date.now() - started
    let body = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    if (res.ok) {
      stats.ok += 1
      stats.lastResults[path] = { ok: true, status: res.status, at: new Date().toISOString(), body }
      log(`${method} ${path} ${res.status} ${ms}ms ${summarise(body)}`.trimEnd())
    } else {
      stats.failed += 1
      const detail = body && typeof body === 'object' && body.error ? ` ${body.error}` : ''
      stats.lastResults[path] = { ok: false, status: res.status, at: new Date().toISOString() }
      log(`${method} ${path} ${res.status} ${ms}ms FAILED${detail}`)
    }
  } catch (err) {
    stats.failed += 1
    const ms = Date.now() - started
    const reason = err && err.name === 'AbortError' ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : (err && err.message) || String(err)
    stats.lastResults[path] = { ok: false, error: reason, at: new Date().toISOString() }
    log(`${method} ${path} ${ms}ms ERROR ${reason} (will retry next tick)`)
  } finally {
    clearTimeout(t)
  }
}

async function tick() {
  if (ticking || stopping) return
  ticking = true
  stats.ticks += 1
  stats.lastTickAt = new Date().toISOString()
  try {
    for (const { path, method, everyMs } of ENDPOINTS) {
      if (stopping) break
      if (everyMs != null) {
        const last = lastCalledAt.get(path)
        if (last != null && Date.now() - last < everyMs - 500) continue
      }
      await callEndpoint(path, method)
    }
  } finally {
    ticking = false
  }
}

function schedule() {
  timer = setInterval(() => void tick(), INTERVAL_MS)
}

let healthServer = null
if (HEALTH_PORT > 0) {
  healthServer = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          app_url: APP_URL,
          interval_ms: INTERVAL_MS,
          calendar_sync_interval_ms: CALENDAR_SYNC_INTERVAL_MS,
          ...stats,
        }),
      )
      return
    }
    res.writeHead(404)
    res.end()
  })
  healthServer.listen(HEALTH_PORT, '127.0.0.1', () => {
    log(`health server on http://127.0.0.1:${HEALTH_PORT}/health`)
  })
}

function shutdown(signal) {
  if (stopping) return
  stopping = true
  log(`${signal} received — stopping after the current call`)
  if (timer) clearInterval(timer)
  const finish = () => {
    if (healthServer) healthServer.close()
    log(`stopped. ticks=${stats.ticks} ok=${stats.ok} failed=${stats.failed}`)
    process.exit(0)
  }
  // Give an in-flight call a moment to complete so the app is not left
  // with a half-claimed row; hard-exit after 5 s regardless.
  const deadline = setTimeout(finish, 5_000)
  const poll = setInterval(() => {
    if (!ticking) {
      clearInterval(poll)
      clearTimeout(deadline)
      finish()
    }
  }, 100)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

log(
  `starting: app=${APP_URL} interval=${INTERVAL_MS}ms calendar_sync=${CALENDAR_SYNC_INTERVAL_MS}ms endpoints=${ENDPOINTS.map((e) => `${e.method} ${e.path}`).join(',')}`,
)
void tick()
schedule()
