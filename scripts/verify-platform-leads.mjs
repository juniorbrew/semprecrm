// Run against the isolated local stack started by platform-leads-runtime.mjs.
// PLAYWRIGHT_MODULE points at an installed playwright/index.mjs, not a network service.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createECDH, randomBytes } from 'node:crypto';
import { createServer } from 'node:https';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import ece from 'http_ece';
import { verificationEnv, workdir } from './platform-leads-runtime.mjs';

const env = verificationEnv();
const base = 'http://127.0.0.1:3107';
const out = 'docs/verification/platform-leads';
mkdirSync(out, { recursive: true });
const admin = createClient(
  env.SUPABASE_INTERNAL_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);
const { chromium } = await import(
  pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
);
const browser = await chromium.launch({ headless: true });
const run = Date.now();
const password = 'Local-verification-847!';
const checks = [];
const pass = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
const unwrap = ({ data, error }) => {
  assert.equal(error, null, error?.message);
  return data;
};
const cookieHeader = (cookies) =>
  cookies.map((c) => `${c.name}=${c.value}`).join('; ');

async function identity(label, platform = false) {
  const email = `${label}-${run}@example.test`;
  const { user } = unwrap(
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: label },
    })
  );
  if (platform)
    unwrap(await admin.from('platform_admins').insert({ user_id: user.id }));
  let cookies = [];
  const client = createServerClient(
    env.SUPABASE_INTERNAL_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookieOptions: { name: 'sb-semprecrm-auth-token' },
      cookies: {
        getAll: () => cookies,
        setAll: (values) => {
          cookies = values;
        },
      },
    }
  );
  unwrap(await client.auth.signInWithPassword({ email, password }));
  return { user, client, cookies, email };
}
const owner = await identity('platform', true);
const tenantA = await identity('tenant-a');
const tenantB = await identity('tenant-b');
const request = (path, identity, init = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(identity ? { cookie: cookieHeader(identity.cookies) } : {}),
      ...init.headers,
    },
  });
const jsonPatch = (status) => ({
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ status }),
});
let provider;
try {
  assert.equal((await request('/api/platform/leads')).status, 401);
  for (const tenant of [tenantA, tenantB]) {
    assert.equal((await request('/api/platform/leads', tenant)).status, 403);
    assert.equal(
      (
        await request(
          '/api/platform/leads/00000000-0000-4000-8000-000000000001',
          tenant,
          jsonPatch('convertido')
        )
      ).status,
      403
    );
    assert.deepEqual(unwrap(await tenant.client.from('leads').select('*')), []);
    assert.ok(
      (
        await tenant.client
          .from('leads')
          .insert({ kind: 'contato', name: 'hacked', email: 'x' })
      ).error
    );
    assert.equal(
      (await tenant.client.rpc('platform_list_leads')).error.code,
      '42501'
    );
    const accounts = unwrap(
      await tenant.client.from('accounts').select('owner_user_id')
    );
    assert.deepEqual(
      accounts.map((a) => a.owner_user_id),
      [tenant.user.id]
    );
  }
  const invalid = {
    cookies: [{ name: 'sb-semprecrm-auth-token', value: 'base64-invalid' }],
  };
  assert.equal((await request('/api/platform/leads', invalid)).status, 401);
  pass(
    'HTTP auth + direct Supabase RLS: anon, invalid session, tenant A/B isolated'
  );

  const publicContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const contact = await publicContext.newPage();
  await contact.goto(`${base}/contato`);
  await contact.locator('#name').fill('Marina Oliveira');
  await contact.locator('#email').fill(`contact-${run}@example.test`);
  await contact.locator('#company').fill('Aurora Tecnologia');
  await contact
    .locator('#message')
    .fill('Quero conhecer o plano para minha equipe.');
  await contact.getByRole('button', { name: 'Enviar mensagem' }).click();
  await contact.getByText('Mensagem enviada!', { exact: true }).waitFor();
  const contactLeads = unwrap(
    await admin
      .from('leads')
      .select('*')
      .eq('email', `contact-${run}@example.test`)
  );
  assert.equal(contactLeads.length, 1);
  const contactLead = contactLeads[0];
  assert.equal(contactLead.kind, 'contato');
  assert.equal(contactLead.status, 'novo');
  pass('/contato browser submission creates exactly one new contato lead');

  await contact.goto(`${base}/signup`);
  await contact.locator('#tax-id').fill('52998224725');
  await contact.locator('#fullName').fill('Rafael Almeida');
  await contact.locator('#email').fill(`signup-${run}@example.test`);
  await contact.locator('#password').fill(password);
  await contact.locator('#confirmPassword').fill(password);
  const signupResponse = contact.waitForResponse(
    (r) =>
      r.url().includes('/auth/v1/signup') && r.request().method() === 'POST'
  );
  await contact.locator('button[type="submit"]').click();
  assert.equal((await signupResponse).status(), 200);
  const signups = unwrap(
    await admin
      .from('leads')
      .select('*')
      .eq('email', `signup-${run}@example.test`)
  );
  assert.equal(signups.length, 1);
  assert.equal(signups[0].kind, 'cadastro');
  assert.ok(signups[0].account_id);
  pass(
    '/signup browser submission creates account + exactly one cadastro lead with owner email'
  );
  await publicContext.close();

  // Populate enough real source rows to exercise pagination; all synthetic data.
  unwrap(
    await admin.from('contact_submissions').insert(
      Array.from({ length: 28 }, (_, i) => ({
        name: [
          'Beatriz Santos',
          'Lucas Ferreira',
          'Camila Costa',
          'Pedro Ribeiro',
        ][i % 4],
        email: `fixture-${run}-${i}@example.test`,
        company: [
          'Horizonte Saúde',
          'Estúdio Norte',
          'Atlas Consultoria',
          'Verde Comércio',
        ][i % 4],
        message: 'Solicitação de demonstração',
      }))
    )
  );
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'light',
  });
  await context.addCookies(
    owner.cookies.map((c) => ({
      name: c.name,
      value: c.value,
      url: base,
      httpOnly: false,
      sameSite: 'Lax',
    }))
  );
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  let gets = 0;
  page.on('request', (req) => {
    if (req.url().includes('/api/platform/leads') && req.method() === 'GET')
      gets++;
  });
  await page.goto(`${base}/platform/leads`);
  await page.getByRole('heading', { name: 'Leads', exact: true }).waitFor();
  assert.equal(gets, 0, 'SSR must not double-fetch in client');
  assert.equal(await page.locator('tbody tr').count(), 25);
  if (
    await page.getByRole('button', { name: 'Switch to light mode' }).count()
  ) {
    await page.getByRole('button', { name: 'Switch to light mode' }).click();
  }
  await page.screenshot({ path: `${out}/desktop-light.png`, fullPage: true });
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await page.screenshot({ path: `${out}/desktop-dark.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${out}/mobile-dark.png` });
  await page.getByRole('button', { name: 'Switch to light mode' }).click();
  await page.screenshot({ path: `${out}/mobile-light.png` });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    ),
    'mobile no horizontal overflow'
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  const next = page.waitForResponse((r) =>
    r.url().includes('/api/platform/leads?')
  );
  await page.getByRole('button', { name: 'Próxima' }).click();
  await next;
  await page.getByText(/26–/).waitFor();
  pass(
    'SSR list, 25-row server pagination, desktop/mobile light+dark, no initial double fetch'
  );

  await page.locator('#lead-search').fill(`contact-${run}@example.test`);
  const search = page.waitForResponse((r) =>
    r.url().includes('/api/platform/leads?')
  );
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
  await search;
  await page
    .locator('tbody tr')
    .getByText('Marina Oliveira', { exact: true })
    .waitFor();
  const change = page.waitForResponse(
    (r) =>
      r.request().method() === 'PATCH' &&
      r.url().includes('/api/platform/leads/')
  );
  await page.locator('table select').selectOption('em_contato');
  assert.equal((await change).status(), 200);
  await page.getByText('Status atualizado.', { exact: true }).waitFor();
  await page.reload();
  assert.equal(
    unwrap(
      await admin
        .from('leads')
        .select('status')
        .eq('id', contactLead.id)
        .single()
    ).status,
    'em_contato'
  );
  pass('UI search + direct status edit persists after reload');

  await page.locator('#lead-status').selectOption('em_contato');
  await page.locator('#lead-kind').selectOption('contato');
  const filtered = page.waitForResponse((r) =>
    r.url().includes('/api/platform/leads?')
  );
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
  await filtered;
  await page
    .locator('tbody tr')
    .getByText('Marina Oliveira', { exact: true })
    .waitFor();
  await page.screenshot({ path: `${out}/filtered.png`, fullPage: true });
  // Real API failure path via route interception, without replacing successful flows.
  await page.route('**/api/platform/leads/**', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: '{"error":"Controlled failure"}',
    })
  );
  await page.locator('table select').selectOption('convertido');
  await page.getByRole('alert').waitFor();
  assert.equal(await page.locator('table select').inputValue(), 'em_contato');
  await page.screenshot({ path: `${out}/status-error.png`, fullPage: true });
  await page.unroute('**/api/platform/leads/**');
  pass('status/type filters + failed status leaves confirmed value intact');

  await page.locator('#lead-search').fill('does-not-exist-unique');
  let release;
  const paused = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/platform/leads?*', async (route) => {
    await paused;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
  await page.getByText('Carregando leads…', { exact: true }).waitFor();
  await page.screenshot({ path: `${out}/loading.png`, fullPage: true });
  release();
  await page.getByText('Nenhum lead encontrado', { exact: true }).waitFor();
  await page.screenshot({ path: `${out}/empty.png`, fullPage: true });
  await page.unroute('**/api/platform/leads?*');
  await page.route('**/api/platform/leads?*', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
  );
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
  await page.getByRole('alert').waitFor();
  await page.screenshot({ path: `${out}/list-error.png`, fullPage: true });
  await page.unroute('**/api/platform/leads?*');
  pass('loading/empty/error visual states captured; retry control present');

  const xss = '<script>alert(1)</script>';
  unwrap(
    await admin
      .from('contact_submissions')
      .insert({
        name: xss,
        email: `xss-${run}@example.test`,
        company: '<img src=x onerror=alert(1)>',
        message: 'XSS fixture',
      })
  );
  await page.reload();
  assert.equal(
    await page.locator('tbody tr').getByText(xss, { exact: true }).count(),
    1
  );
  assert.equal(await page.locator('tbody script, tbody img').count(), 0);
  await page.screenshot({ path: `${out}/xss-text.png`, fullPage: true });
  assert.deepEqual(consoleErrors, []);
  const storage = await page.evaluate(() => ({
    local: { ...localStorage },
    session: { ...sessionStorage },
    html: document.documentElement.outerHTML,
  }));
  for (const secret of [
    env.SUPABASE_SERVICE_ROLE_KEY,
    env.VAPID_PRIVATE_KEY,
    env.AUTOMATION_CRON_SECRET,
    env.ENCRYPTION_KEY,
  ]) {
    assert.ok(
      !JSON.stringify(storage).includes(secret),
      'server secret absent from browser DOM/storage'
    );
  }
  pass(
    'XSS renders text, no injected elements, no page exceptions, browser DOM/storage secrets absent'
  );
  await context.close();

  const badCases = [
    ['/api/platform/leads/bad', jsonPatch('novo'), 400],
    [`/api/platform/leads/${contactLead.id}`, jsonPatch('bad'), 400],
    [
      '/api/platform/leads/00000000-0000-4000-8000-000000000000',
      jsonPatch('novo'),
      404,
    ],
    [
      `/api/platform/leads/${contactLead.id}`,
      {
        ...jsonPatch('novo'),
        body: JSON.stringify({ status: 'novo', email: 'hacked' }),
      },
      400,
    ],
    [`/api/platform/leads/${contactLead.id}`, jsonPatch('x'.repeat(2048)), 413],
    ['/api/platform/leads?limit=9999', {}, 400],
  ];
  for (const [path, init, status] of badCases)
    assert.equal((await request(path, owner, init)).status, status);
  const replay = await request(
    `/api/platform/leads/${contactLead.id}`,
    owner,
    jsonPatch('em_contato')
  );
  assert.equal(replay.status, 200);
  assert.equal(
    (
      await request(
        `/api/platform/leads/${contactLead.id}`,
        owner,
        jsonPatch('em_contato')
      )
    ).status,
    200
  );
  pass(
    'manual HTTP: manipulated UUID/status, missing lead, extra fields, oversized body, bounded pagination, idempotent status replay'
  );

  // Deterministic HTTPS Web Push receiver: actual VAPID/encryption/network sender,
  // controlled 503 and decryption, no external provider or real user subscriptions.
  const keys = createECDH('prime256v1');
  keys.generateKeys();
  const authSecret = randomBytes(16);
  const received = [];
  let fail = false;
  provider = createServer(
    {
      key: readFileSync(join(workdir, 'push-key.pem')),
      cert: readFileSync(join(workdir, 'push-cert.pem')),
    },
    async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(
        ece
          .decrypt(Buffer.concat(chunks), {
            version: 'aes128gcm',
            privateKey: keys,
            authSecret,
          })
          .toString()
      );
      received.push({ path: req.url, payload, status: fail ? 503 : 201 });
      res.writeHead(fail ? 503 : 201);
      res.end();
    }
  );
  await new Promise((resolve) => provider.listen(57443, '127.0.0.1', resolve));
  // Test harness owns every row in this isolated stack. Suspend old fixtures.
  unwrap(
    await admin
      .from('leads')
      .update({ notification_next_attempt_at: '2099-01-01T00:00:00Z' })
      .is('notified_at', null)
  );
  const account = unwrap(
    await admin
      .from('accounts')
      .select('id')
      .eq('owner_user_id', owner.user.id)
      .single()
  );
  unwrap(
    await admin
      .from('push_subscriptions')
      .insert({
        account_id: account.id,
        user_id: owner.user.id,
        endpoint: `https://127.0.0.1:57443/${run}`,
        p256dh: keys.getPublicKey().toString('base64url'),
        auth: authSecret.toString('base64url'),
      })
  );
  const createPushLead = async (suffix) => {
    const email = `push-${run}-${suffix}@example.test`;
    unwrap(
      await admin
        .from('contact_submissions')
        .insert({
          name: 'Novo cliente',
          email,
          company: 'Empresa Push',
          message: 'Teste push',
        })
    );
    return unwrap(
      await admin.from('leads').select('*').eq('email', email).single()
    );
  };
  const tick = async () => {
    const res = await fetch(`${base}/api/automations/cron`, {
      headers: { 'x-cron-secret': env.AUTOMATION_CRON_SECRET },
    });
    assert.equal(res.status, 200);
    return res.json();
  };
  const pushLead = await createPushLead('ok');
  const concurrent = await Promise.all([tick(), tick()]);
  assert.equal(
    concurrent.reduce((sum, r) => sum + r.lead_notifications.notified, 0),
    1
  );
  assert.equal(received.length, 1);
  assert.equal(received[0].payload.tag, `lead:${pushLead.id}`);
  assert.equal(received[0].payload.title, 'Novo lead: Novo cliente');
  assert.equal(received[0].payload.data.url, '/platform/leads');
  let current = unwrap(
    await admin.from('leads').select('*').eq('id', pushLead.id).single()
  );
  assert.ok(current.notified_at);
  assert.equal(current.notification_claimed_at, null);
  assert.equal(current.notification_attempts, 1);
  await tick();
  assert.equal(received.length, 1);
  pass(
    'two concurrent real cron HTTP requests: one encrypted push, durable success, no second-tick duplicate'
  );

  const failedLead = await createPushLead('retry');
  fail = true;
  await tick();
  current = unwrap(
    await admin.from('leads').select('*').eq('id', failedLead.id).single()
  );
  assert.equal(current.notified_at, null);
  assert.equal(current.notification_attempts, 1);
  assert.equal(current.notification_claimed_at, null);
  const before = received.length;
  await tick();
  assert.equal(received.length, before);
  unwrap(
    await admin
      .from('leads')
      .update({ notification_next_attempt_at: new Date().toISOString() })
      .eq('id', failedLead.id)
  );
  fail = false;
  await tick();
  current = unwrap(
    await admin.from('leads').select('*').eq('id', failedLead.id).single()
  );
  assert.ok(current.notified_at);
  assert.equal(current.notification_attempts, 2);
  await tick();
  assert.equal(received.length, before + 1);
  pass(
    'controlled provider 503: no false success, attempt counted, claim released, backoff, later retry succeeds once'
  );
  writeFileSync(
    `${out}/e2e-results.json`,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        checks,
        consoleErrors,
        pushRequests: received.length,
        note: 'Real local HTTP/Web Push encryption with controlled HTTPS receiver; not proof of delivery to an external browser push service.',
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
  if (provider) await new Promise((resolve) => provider.close(resolve));
}
