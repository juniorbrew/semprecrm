// Read/write verification is restricted to the isolated local test stack.
// Supply SUPABASE_CLI and LEADS_TEST_WORKDIR as for platform-leads-runtime.mjs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  openSync,
  closeSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { verificationEnv, workdir } from './platform-leads-runtime.mjs';
import { verifyPlanCatalog } from './verify-plan-catalog.mjs';

const env = verificationEnv();
assert.ok(
  ['http://127.0.0.1:57021', 'http://127.0.0.1:58021'].includes(
    env.SUPABASE_INTERNAL_URL
  )
);
const base = 'http://localhost:3107';
const browserBin = process.env.AGENT_BROWSER_BIN;
assert.ok(
  browserBin,
  'Set AGENT_BROWSER_BIN to the installed agent-browser executable'
);
const session = 'semprecrm-platform-validation';
const out =
  process.env.PLATFORM_VERIFICATION_DIR ||
  'docs/verification/platform-overview';
mkdirSync(out, { recursive: true });
const admin = createClient(
  env.SUPABASE_INTERNAL_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);
const users = [];
const accountIds = [];
const checks = [];
const unwrap = ({ data, error }) => {
  assert.equal(error, null, error?.message);
  return data;
};
const pass = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
// A file-backed output prevents a Windows browser daemon from keeping a
// synchronous child's stdout pipe open after the CLI command has finished.
const browserOutput = join(workdir, 'overview-browser-output.txt');
const browser = (...args) => {
  const fd = openSync(browserOutput, 'w');
  try {
    execFileSync(browserBin, ['--session', session, ...args], {
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      timeout: 30_000,
    });
  } catch {
    throw new Error(`Browser command failed: ${args[0]}`);
  } finally {
    closeSync(fd);
  }
  return readFileSync(browserOutput, 'utf8');
};
async function identity(label, platform = false, fields = {}) {
  const emailLabel = label
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-zA-Z0-9-]/g, '-');
  const email = `overview-${emailLabel}-${randomUUID()}@example.test`;
  const password = randomUUID();
  const { user } = unwrap(
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: label },
    })
  );
  users.push(user.id);
  const [account] = unwrap(
    await admin.from('accounts').select('id').eq('owner_user_id', user.id)
  );
  accountIds.push(account.id);
  if (fields.plan) {
    const catalog = unwrap(await admin.rpc('public_plan_catalog'));
    fields = {
      ...fields,
      plan_version_id: catalog.find((v) => v.plan === fields.plan).id,
    };
  }
  unwrap(
    await admin
      .from('accounts')
      .update({ name: `Verificação ${label}`, ...fields })
      .eq('id', account.id)
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
  if (platform) {
    assert.equal(unwrap(await client.rpc('is_platform_admin')), true);
    const reader = createServerClient(
      env.SUPABASE_INTERNAL_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      {
        cookieOptions: { name: 'sb-semprecrm-auth-token' },
        cookies: { getAll: () => cookies, setAll: () => {} },
      }
    );
    assert.equal(
      unwrap(await reader.rpc('is_platform_admin')),
      true,
      'Fresh cookie reader'
    );
  }
  return { cookies, account };
}
const request = (path, identity, init = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: identity
      ? {
          cookie: identity.cookies
            .map((c) => `${c.name}=${c.value}`)
            .join('; '),
        }
      : {},
  });
function noOverflow() {
  return (
    browser(
      'eval',
      'document.documentElement.scrollWidth <= window.innerWidth'
    ).trim() === 'true'
  );
}
// The CLI's text fill clears Chromium native date fields. Set their native
// value and emit the same input/change events used by the date picker.
function fillDate(selector, value) {
  browser(
    'eval',
    `(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', {bubbles: true}));
    input.dispatchEvent(new Event('change', {bubbles: true}));
  })()`
  );
}
function snapshot() {
  return browser('snapshot', '-i');
}
function checkBrowserErrors(stage) {
  const errors = JSON.parse(browser('errors', '--json'));
  assert.equal(errors.success, true);
  assert.deepEqual(errors.data.errors, [], `Browser errors after ${stage}`);
}
function refFor(text) {
  const line = snapshot()
    .split('\n')
    .find((line) => line.includes(text));
  assert.ok(line, `Missing control: ${text}`);
  return line.match(/ref=(e\d+)/)[1];
}

try {
  const operator = await identity('Admin', true, {
    plan_status: 'active',
    plan: 'pro',
    plan_expires_at: null,
  });
  const crmOnly = { cookies: [...operator.cookies] };
  for (const path of ['/platform', '/platform/accounts']) {
    const locked = await request(path, crmOnly, { redirect: 'manual' });
    if (locked.status === 307) {
      assert.ok(locked.headers.get('location').endsWith('/platform/login'));
    } else {
      // Next.js can send redirects after streaming the shell with HTTP 200.
      assert.equal(locked.status, 200);
      const html = await locked.text();
      assert.match(html, /NEXT_REDIRECT;replace;\/platform\/login;307/);
      assert.ok(!html.includes('platform-content'));
      assert.ok(!html.includes('Verificação Admin'));
    }
  }
  const login = await request('/platform/login', crmOnly);
  const loginHtml = await login.text();
  assert.equal(login.status, 200);
  assert.ok(!loginHtml.includes('platform-content'));
  assert.ok(!loginHtml.includes('Verificação Admin'));
  browser('open');
  for (const cookie of crmOnly.cookies)
    browser(
      'cookies',
      'set',
      cookie.name,
      cookie.value,
      '--url',
      base,
      '--path',
      '/'
    );
  browser('open', `${base}/platform`);
  browser('wait', '--url', '**/platform/login');
  assert.ok(!snapshot().includes('Navegação da plataforma'));
  checkBrowserErrors('locked login');
  const gateSetup = await fetch(`${base}/api/platform/gate`, {
    method: 'PUT',
    headers: {
      cookie: operator.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      username: 'overview-admin',
      password: randomUUID(),
    }),
  });
  assert.equal(gateSetup.status, 200, 'Synthetic admin gate setup');
  const gateHeader = gateSetup.headers
    .getSetCookie()
    .find((c) => c.startsWith('sc-platform-gate='));
  assert.ok(gateHeader);
  const gatePair = gateHeader.split(';')[0];
  operator.cookies.push({
    name: 'sc-platform-gate',
    value: gatePair.slice(gatePair.indexOf('=') + 1),
  });
  pass(
    'CRM-only admin remains locked, without sidebar or company data before the second login'
  );
  const tenant = await identity('Ativa', false, {
    plan_status: 'active',
    plan: 'pro',
    plan_expires_at: null,
  });
  await identity('Teste', false, {
    plan_status: 'trial',
    plan: 'trial',
    plan_expires_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
  });
  await identity('Suspensa', false, { plan_status: 'suspended', plan: 'pro' });
  const expired = await identity('Vencida', false, {
    plan_status: 'trial',
    plan: 'trial',
    plan_expires_at: new Date(Date.now() - 86_400_000).toISOString(),
  });
  const limited = await identity('Limite', false, {
    plan_status: 'active',
    plan: 'pro',
    plan_expires_at: null,
    limit_overrides: { max_users: 1 },
  });
  await identity('São José', false, {
    plan_status: 'active',
    plan: 'basico',
    plan_expires_at: new Date(Date.now() + 20 * 86_400_000).toISOString(),
    limit_overrides: { max_users: 1 },
  });
  for (const path of [
    '/platform',
    '/platform/accounts',
    `/platform/${tenant.account.id}`,
  ]) {
    for (const identity of [undefined, tenant]) {
      const denied = await request(path, identity);
      if (denied.status !== 404) {
        assert.equal(denied.status, 200);
        const html = await denied.text();
        assert.match(html, /NEXT_HTTP_ERROR_FALLBACK;404/);
        assert.ok(!html.includes('platform-content'));
        assert.ok(!html.includes('Verificação Admin'));
      }
    }
    assert.equal(
      (await request(path, operator)).status,
      200,
      `Admin access to ${path}`
    );
  }
  pass('Overview, companies and detail restricted to platform admins');
  const filtered = await request('/platform/accounts?status=trial', operator);
  // Browser assertions below check rendered rows, not serialized RSC props.
  assert.equal(filtered.status, 200);
  browser('open');
  for (const cookie of operator.cookies)
    browser(
      'cookies',
      'set',
      cookie.name,
      cookie.value,
      '--url',
      base,
      '--path',
      '/',
      ...(cookie.name === 'sc-platform-gate' ? ['--httpOnly'] : [])
    );
  browser('open', `${base}/platform`);
  browser('wait', '--text', 'Uma visão consolidada das empresas no SempreCRM.');
  assert.ok(
    snapshot().includes('Planos'),
    'Platform catalog navigation exists'
  );
  checkBrowserErrors('overview');
  assert.match(browser('get', 'text', 'body'), /Plano vencido/);
  assert.match(browser('get', 'text', 'body'), /Limite de usuários atingido/);
  browser('set', 'viewport', '1440', '1000');
  browser('screenshot', join(out, 'desktop.png'), '--full');
  assert.ok(noOverflow());
  browser('click', refFor('Atualizar visão geral'));
  browser('wait', '--text', 'Atualizar visão geral');
  pass('Overview displays expiration/capacity alerts and refreshes');
  browser('open', `${base}/platform/accounts?status=trial`);
  browser('wait', '--text', 'Empresas cadastradas');
  let table = browser('get', 'text', 'tbody');
  assert.match(table, /Verificação Teste/);
  assert.ok(!table.includes('Verificação Vencida'));
  browser('open', `${base}/platform/accounts?attention=expired`);
  browser('wait', '--text', 'Empresas cadastradas');
  assert.equal(
    browser('get', 'value', '#company-expiry-filter').trim(),
    'expired'
  );
  table = browser('get', 'text', 'tbody');
  assert.match(table, /Verificação Vencida/);
  assert.ok(!table.includes('Verificação Ativa'));
  for (const width of [640, 768, 375]) {
    browser('set', 'viewport', String(width), '900');
    assert.ok(noOverflow(), `Company filters overflow at ${width}px`);
  }
  browser('fill', refFor('Pesquisar contas'), 'Verificação');
  browser('screenshot', join(out, 'companies-mobile.png'), '--full');
  browser('fill', refFor('Pesquisar contas'), 'no-company-for-this-search');
  browser('wait', '--text', 'Nenhuma conta');
  assert.match(browser('get', 'text', 'tbody'), /Nenhuma conta/);
  pass('Trial/expired filters, search empty state and tablet/mobile layout');
  checkBrowserErrors('companies');
  browser(
    'open',
    `${base}/platform/accounts?plan=basico&status=active&expiry=30days&attention=limits&q=sao%20jose`
  );
  browser('wait', '--text', 'Empresas cadastradas');
  table = browser('get', 'text', 'tbody');
  assert.match(table, /Verificação São José/);
  assert.ok(!table.includes('Verificação Limite'));
  assert.equal(
    browser('get', 'value', '#company-plan-filter').trim(),
    'basico'
  );
  assert.equal(
    browser('get', 'value', '#company-expiry-filter').trim(),
    '30days'
  );
  browser('select', '#company-expiry-filter', '7days');
  browser('wait', '--text', 'Nenhuma conta');
  browser('click', refFor('Limpar filtros'));
  assert.match(browser('get', 'text', 'tbody'), /Verificação Limite/);
  assert.equal(browser('get', 'value', '#company-plan-filter').trim(), 'all');
  assert.equal(browser('get', 'value', '#company-expiry-filter').trim(), 'all');
  browser('select', '#company-plan-filter', 'pro');
  browser('select', '#company-expiry-filter', 'none');
  table = browser('get', 'text', 'tbody');
  assert.match(table, /Verificação Limite/);
  assert.ok(
    !table.includes('Verificação São José') &&
      !table.includes('Verificação Teste') &&
      !table.includes('Verificação Vencida')
  );
  browser('click', refFor('Limpar filtros'));
  browser('select', '#company-plan-filter', 'basico');
  browser('select', '#company-expiry-filter', '30days');
  browser('fill', refFor('Pesquisar contas'), 'sao jose');
  for (const width of [1440, 768, 375]) {
    browser('set', 'viewport', String(width), '1000');
    assert.ok(noOverflow(), `Plan/expiry filters overflow at ${width}px`);
    if (width !== 768)
      browser('screenshot', join(out, `company-filters-${width}.png`));
  }
  const filtersAudit = JSON.parse(browser('a11y', '--json'));
  writeFileSync(
    join(out, 'company-filters-a11y.json'),
    JSON.stringify(filtersAudit, null, 2)
  );
  assert.equal(filtersAudit.data.counts.violations, 0);
  browser('set', 'viewport', '1440', '1000');
  browser('click', refFor('Mudar para o modo claro'));
  browser('wait', '--fn', 'document.getAnimations().length === 0');
  browser('screenshot', join(out, 'company-filters-light.png'));
  const filtersLightAudit = JSON.parse(browser('a11y', '--json'));
  writeFileSync(
    join(out, 'company-filters-a11y-light.json'),
    JSON.stringify(filtersLightAudit, null, 2)
  );
  assert.equal(filtersLightAudit.data.counts.violations, 0);
  browser('click', refFor('Mudar para o modo escuro'));
  pass(
    'Plan/expiry/capacity/status combined filters, accent-insensitive search, clear filters, URL defaults and responsive light/dark accessibility'
  );
  checkBrowserErrors('combined company filters');
  browser('open', `${base}/platform/${expired.account.id}`);
  browser('wait', '--text', 'Verificação Vencida');
  assert.match(snapshot(), /\/platform\/accounts|Voltar|Contas/);
  browser('wait', '--text', 'Resumo da empresa');
  const summarySelector = 'section[aria-labelledby="company-summary-title"]';
  const expiredSummary = browser('get', 'text', summarySelector);
  assert.match(expiredSummary, /Plano vencido/);
  assert.match(expiredSummary, /O acesso da empresa está bloqueado/);
  browser('select', '#plan', 'pro');
  assert.equal(
    browser('get', 'text', summarySelector),
    expiredSummary,
    'Unsaved edits must not change saved summary'
  );
  browser('open', `${base}/platform/${limited.account.id}`);
  browser('wait', '--text', 'Resumo da empresa');
  const limitedSummary = browser('get', 'text', summarySelector);
  assert.match(limitedSummary, /1 \/ 1/);
  assert.match(limitedSummary, /Limite de usuários atingido/);
  assert.match(limitedSummary, /Sem data de vencimento/);
  for (const width of [1440, 768, 375]) {
    browser('set', 'viewport', String(width), '1000');
    assert.ok(noOverflow(), `Company detail overflow at ${width}px`);
    if (width !== 768)
      browser('screenshot', join(out, `company-summary-${width}.png`));
  }
  browser('set', 'viewport', '1440', '1000');
  const summaryAudit = JSON.parse(browser('a11y', '--json'));
  writeFileSync(
    join(out, 'company-summary-a11y.json'),
    JSON.stringify(summaryAudit, null, 2)
  );
  assert.equal(summaryAudit.data.counts.violations, 0);
  browser('click', refFor('Mudar para o modo claro'));
  browser('screenshot', join(out, 'company-summary-light.png'));
  const summaryLightAudit = JSON.parse(browser('a11y', '--json'));
  writeFileSync(
    join(out, 'company-summary-a11y-light.json'),
    JSON.stringify(summaryLightAudit, null, 2)
  );
  assert.equal(summaryLightAudit.data.counts.violations, 0);
  browser('click', refFor('Mudar para o modo escuro'));
  browser('set', 'viewport', '375', '900');
  pass(
    'Saved company summary, expiry/access alerts, capacity overrides, draft separation, responsive layout and accessibility'
  );
  checkBrowserErrors('company detail');
  // Read-only company activity: seed only this run's isolated fixtures.
  const hidden = `synthetic-hidden-${randomUUID()}`;
  const [owner] = unwrap(
    await admin
      .from('profiles')
      .select('user_id')
      .eq('account_id', limited.account.id)
  );
  unwrap(
    await admin.from('account_invitations').insert([
      {
        account_id: limited.account.id,
        token_hash: `${hidden}-pending`,
        role: 'agent',
        label: 'Convite de verificação',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
      {
        account_id: limited.account.id,
        token_hash: `${hidden}-expired`,
        role: 'agent',
        label: 'Convite expirado oculto',
        expires_at: new Date(Date.now() - 86_400_000).toISOString(),
      },
      {
        account_id: limited.account.id,
        token_hash: `${hidden}-accepted`,
        role: 'agent',
        label: 'Convite aceito oculto',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        accepted_at: new Date().toISOString(),
      },
    ])
  );
  unwrap(
    await admin.from('whatsapp_config').insert({
      account_id: limited.account.id,
      user_id: owner.user_id,
      phone_number_id: 'synthetic-phone-id',
      access_token: hidden,
      verify_token: hidden,
      status: 'connected',
    })
  );
  unwrap(
    await admin.from('wa_qr_sessions').insert({
      account_id: limited.account.id,
      status: 'connected',
      phone_number: '5511999999999',
      display_name: 'Canal de verificação ' + 'NomeSemEspacos'.repeat(12),
      last_error: hidden,
    })
  );
  const historyTime = new Date(Date.now() - 1000).toISOString();
  unwrap(
    await admin.from('audit_log').insert([
      ...Array.from({ length: 26 }, () => ({
        account_id: limited.account.id,
        actor_name: 'Administrador de verificação (platform)',
        action: 'plan.changed',
        entity_type: 'plan',
        created_at: historyTime,
        metadata: { secret: hidden },
      })),
      {
        account_id: tenant.account.id,
        actor_name: 'Outra empresa oculta',
        action: 'plan.changed',
        entity_type: 'plan',
        created_at: historyTime,
        metadata: { secret: hidden },
      },
    ])
  );
  const activityPath = `/api/platform/accounts/${limited.account.id}/activity`;
  for (const [identity, status] of [
    [undefined, 401],
    [tenant, 403],
    [crmOnly, 401],
  ]) {
    assert.equal(
      (await request(`${activityPath}?section=members`, identity)).status,
      status
    );
  }
  for (const section of ['members', 'invitations', 'channels', 'history']) {
    const response = await request(
      `${activityPath}?section=${section}`,
      operator
    );
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes(hidden) && !text.includes('Outra empresa oculta'));
    if (section === 'invitations') {
      const page = JSON.parse(text);
      assert.equal(page.items.length, 1);
      assert.equal(page.items[0].label, 'Convite de verificação');
    }
    if (section === 'members')
      assert.equal(JSON.parse(text).items[0].user_id, owner.user_id);
    if (section === 'channels') assert.equal(JSON.parse(text).items.length, 2);
    if (section === 'history') {
      const page = JSON.parse(text);
      assert.equal(page.items.length, 25);
      const next = await request(
        `${activityPath}?section=history&cursor=${encodeURIComponent(page.nextCursor)}`,
        operator
      );
      const second = await next.json();
      assert.equal(second.items.length, 1);
      assert.equal(second.nextCursor, null);
      assert.equal(
        new Set([...page.items, ...second.items].map((row) => row.id)).size,
        26
      );
    }
  }
  browser('open', `${base}/platform/${limited.account.id}`);
  browser('wait', '--text', 'Convite de verificação');
  const activitySelector = 'section[aria-labelledby="company-activity-title"]';
  assert.match(browser('get', 'text', activitySelector), /Usuários/);
  browser('set', 'viewport', '1440', '1000');
  browser('scrollintoview', '#company-activity-title');
  browser('screenshot', join(out, 'company-users-1440.png'));
  browser('set', 'viewport', '375', '1000');
  browser('scrollintoview', '#company-activity-title');
  assert.ok(noOverflow());
  browser('screenshot', join(out, 'company-users-375.png'));
  assert.ok(
    !browser('get', 'text', activitySelector).includes(
      'Convite expirado oculto'
    )
  );
  browser('select', '#plan', 'empresa');
  browser('click', refFor('Canais'));
  browser('wait', '--text', 'Canal de verificação');
  assert.match(browser('get', 'text', activitySelector), /synthetic-phone-id/);
  browser('click', refFor('Histórico de alterações'));
  browser('wait', '--text', '25 registros carregados');
  browser('click', refFor('Carregar mais'));
  browser('wait', '--text', '26 registros carregados');
  assert.equal(
    browser('get', 'value', '#plan').trim(),
    'empresa',
    'Tabs preserve unsaved form changes'
  );
  browser('click', refFor('Atualizar lista'));
  browser('wait', '--text', '25 registros carregados');
  assert.equal(browser('get', 'value', '#plan').trim(), 'empresa');
  browser('scrollintoview', '#company-activity-title');
  for (const width of [1440, 768, 375]) {
    browser('set', 'viewport', String(width), '1000');
    browser('click', refFor('Canais'));
    assert.ok(noOverflow(), `Long channel name overflow at ${width}px`);
    browser('scrollintoview', '#company-activity-title');
    if (width === 375)
      browser('screenshot', join(out, 'company-channels-375.png'));
    browser('click', refFor('Histórico de alterações'));
    browser('scrollintoview', '#company-activity-title');
    assert.ok(noOverflow(), `Activity overflow at ${width}px`);
    if (width !== 768)
      browser('screenshot', join(out, `company-activity-${width}.png`));
  }
  const activityAudit = JSON.parse(browser('a11y', '--json'));
  writeFileSync(
    join(out, 'company-activity-a11y.json'),
    JSON.stringify(activityAudit, null, 2)
  );
  assert.equal(activityAudit.data.counts.violations, 0);
  browser('set', 'viewport', '1440', '1000');
  browser('click', refFor('Mudar para o modo claro'));
  browser('wait', '--fn', 'document.getAnimations().length === 0');
  browser('scrollintoview', '#company-activity-title');
  browser('screenshot', join(out, 'company-activity-light.png'));
  const activityLightAudit = JSON.parse(browser('a11y', '--json'));
  writeFileSync(
    join(out, 'company-activity-a11y-light.json'),
    JSON.stringify(activityLightAudit, null, 2)
  );
  assert.equal(activityLightAudit.data.counts.violations, 0);
  browser('click', refFor('Mudar para o modo escuro'));
  browser('click', refFor('Canais'));
  browser('network', 'route', '**/activity?section=channels', '--body', '{}');
  browser('click', refFor('Atualizar lista'));
  browser(
    'wait',
    '--text',
    'Não foi possível carregar esta lista. Tente novamente.'
  );
  browser('network', 'unroute', '**/activity?section=channels');
  browser('click', refFor('Tentar novamente'));
  browser(
    'wait',
    '--fn',
    "!document.querySelector('section[aria-labelledby=company-activity-title] [role=alert]')"
  );
  checkBrowserErrors('company activity');
  browser('open', `${base}/platform/${expired.account.id}`);
  browser('wait', '--text', 'Nenhum convite pendente.');
  browser('click', refFor('Canais'));
  browser('wait', '--text', 'Nenhum canal configurado nesta empresa.');
  browser('click', refFor('Histórico de alterações'));
  browser('wait', '--text', 'Nenhuma alteração registrada nesta empresa.');
  pass(
    'Company members/invitations/channels/history isolation, secret projection, keyset pagination, draft preservation, refresh/retry, empty states and responsive accessibility'
  );
  const historyFixture = (created_at, actor_name, action = 'plan.changed') => ({
    account_id: limited.account.id,
    created_at,
    actor_name,
    action,
    entity_type: 'plan',
    metadata: {
      secret: hidden,
      changes: {
        plan: { from: 'trial', to: 'pro' },
        plan_status: { from: 'trial', to: 'active' },
        module_overrides: { from: {}, to: { tasks: false, password: hidden } },
        limit_overrides: { from: {}, to: { max_users: null, token: hidden } },
        plan_expires_at: { from: '2026-10-01T03:00:00Z', to: null },
      },
    },
  });
  unwrap(
    await admin
      .from('audit_log')
      .insert([
        historyFixture('2026-10-01T02:59:59.999999Z', 'Antes do período'),
        historyFixture('2026-10-01T03:00:00Z', 'Maria do início'),
        historyFixture('2026-10-03T02:59:59.999999Z', 'Maria do fim'),
        historyFixture('2026-10-03T03:00:00Z', 'Depois do período'),
        historyFixture(
          '2026-10-02T12:00:00Z',
          'Maria outra ação',
          'account.renamed'
        ),
        historyFixture('2026-10-02T12:00:00Z', 'Administrador A_%'),
      ])
  );
  const historyQuery = new URLSearchParams({
    section: 'history',
    startDate: '2026-10-01',
    endDate: '2026-10-02',
    action: 'plan.changed',
    actor: 'Maria',
  });
  const filteredHistory = await (
    await request(`${activityPath}?${historyQuery}`, operator)
  ).json();
  assert.deepEqual(
    filteredHistory.items.map((row) => row.actor_name),
    ['Maria do fim', 'Maria do início']
  );
  assert.equal(filteredHistory.items[0].changes.length, 5);
  assert.ok(!JSON.stringify(filteredHistory).includes(hidden));
  historyQuery.set('actor', 'A_%');
  const literalHistory = await (
    await request(`${activityPath}?${historyQuery}`, operator)
  ).json();
  assert.equal(literalHistory.items.length, 1);
  assert.equal(literalHistory.items[0].actor_name, 'Administrador A_%');
  const pagingFilters = new URLSearchParams({
    section: 'history',
    action: 'plan.changed',
    actor: 'Administrador de verificação',
  });
  const firstFiltered = await (
    await request(`${activityPath}?${pagingFilters}`, operator)
  ).json();
  assert.equal(firstFiltered.items.length, 25);
  assert.ok(firstFiltered.nextCursor);
  pagingFilters.set('cursor', firstFiltered.nextCursor);
  const nextFiltered = await (
    await request(`${activityPath}?${pagingFilters}`, operator)
  ).json();
  assert.equal(nextFiltered.items.length, 1);
  assert.equal(nextFiltered.nextCursor, null);
  assert.equal(
    new Set(
      [...firstFiltered.items, ...nextFiltered.items].map((row) => row.id)
    ).size,
    26
  );
  browser('open', `${base}/platform/${limited.account.id}`);
  browser('wait', '--text', 'Convite de verificação');
  browser('select', '#plan', 'empresa');
  browser('click', refFor('Histórico de alterações'));
  browser('wait', '--text', '25 registros carregados');
  fillDate('#history-start-date', '2026-10-01');
  fillDate('#history-end-date', '2026-10-02');
  assert.equal(
    browser('get', 'value', '#history-start-date').trim(),
    '2026-10-01',
    'Native start date fill'
  );
  assert.equal(
    browser('get', 'value', '#history-end-date').trim(),
    '2026-10-02',
    'Native end date fill'
  );
  browser('select', '#history-action', 'plan.changed');
  browser('fill', '#history-actor', 'Maria');
  browser('click', refFor('Aplicar filtros'));
  browser('wait', '--text', '2 registros carregados');
  browser('click', refFor('Canais'));
  browser('wait', '--text', 'Canal de verificação');
  browser('click', refFor('Histórico de alterações'));
  browser('wait', '--text', '2 registros carregados');
  assert.equal(browser('get', 'value', '#history-actor').trim(), 'Maria');
  const historyText = browser('get', 'text', activitySelector);
  assert.ok(
    historyText.includes('Maria do início') &&
      historyText.includes('Maria do fim')
  );
  assert.ok(historyText.includes('Antes:') && historyText.includes('Depois:'));
  assert.ok(
    historyText.includes('Herdar do plano') && historyText.includes('Ilimitado')
  );
  assert.ok(
    !historyText.includes('Antes do período') && !historyText.includes(hidden)
  );
  for (const width of [1440, 768, 375]) {
    browser('set', 'viewport', String(width), '1000');
    browser('scrollintoview', '#company-activity-title');
    assert.ok(noOverflow());
    if (width !== 768)
      browser('screenshot', join(out, `company-history-${width}.png`));
  }
  const historyAudit = JSON.parse(browser('a11y', '--json'));
  assert.equal(historyAudit.data.counts.violations, 0);
  writeFileSync(
    join(out, 'company-history-a11y.json'),
    JSON.stringify(historyAudit, null, 2)
  );
  browser('set', 'viewport', '1440', '1000');
  browser('click', refFor('Mudar para o modo claro'));
  browser('wait', '--fn', 'document.getAnimations().length === 0');
  browser('screenshot', join(out, 'company-history-light.png'));
  const historyLightAudit = JSON.parse(browser('a11y', '--json'));
  assert.equal(historyLightAudit.data.counts.violations, 0);
  writeFileSync(
    join(out, 'company-history-a11y-light.json'),
    JSON.stringify(historyLightAudit, null, 2)
  );
  browser('click', refFor('Mudar para o modo escuro'));
  fillDate('#history-start-date', '2026-10-03');
  assert.equal(
    browser('get', 'value', '#history-start-date').trim(),
    '2026-10-03',
    'Inverted native date fill'
  );
  browser('click', refFor('Aplicar filtros'));
  browser(
    'wait',
    '--text',
    'A data final deve ser igual ou posterior à data inicial.'
  );
  assert.match(
    browser('get', 'text', activitySelector),
    /2 registros carregados/
  );
  fillDate('#history-start-date', '2026-10-01');
  browser('fill', '#history-actor', 'Nome inexistente');
  browser('click', refFor('Aplicar filtros'));
  browser('wait', '--text', 'Nenhuma alteração encontrada com estes filtros.');
  browser('click', refFor('Limpar filtros'));
  browser('wait', '--text', '25 registros carregados');
  assert.equal(browser('get', 'value', '#history-start-date').trim(), '');
  assert.equal(browser('get', 'value', '#plan').trim(), 'empresa');
  checkBrowserErrors('filtered administrative history');
  pass(
    'Company history inclusive Bahia dates, combined action/actor filters, literal search, safe before/after details, invalid/empty/clear states and responsive light/dark accessibility'
  );
  browser('open', `${base}/platform/leads`);
  browser('wait', '--text', 'Acompanhe contatos e novas contas trial.');
  assert.equal(
    browser('get', 'text', 'label[for="lead-status"]').trim(),
    'Situação'
  );
  for (const [language, label] of [
    ['en-US', 'Status'],
    ['pt-BR', 'Situação'],
  ]) {
    browser(
      'eval',
      `localStorage.setItem('semprecrm-language', '${language}'); window.dispatchEvent(new StorageEvent('storage', { key: 'semprecrm-language', newValue: '${language}' }));`
    );
    browser(
      'wait',
      '--fn',
      `document.querySelector('label[for="lead-status"]').textContent === '${label}'`
    );
    browser(
      'wait',
      '--fn',
      `document.querySelectorAll('thead th')[4].textContent === '${label}'`
    );
  }
  pass('Lead status labels translate without pre-hydration DOM mutation');
  checkBrowserErrors('leads');
  pass('Company editor and existing leads page remain accessible');
  browser('open', `${base}/platform`);
  browser('wait', '--text', 'Uma visão consolidada das empresas no SempreCRM.');
  assert.ok(noOverflow());
  browser('screenshot', join(out, 'mobile.png'), '--full');
  const errors = JSON.parse(browser('errors', '--json'));
  writeFileSync(
    join(out, 'browser-errors.json'),
    JSON.stringify(errors, null, 2)
  );
  assert.equal(errors.success, true);
  assert.deepEqual(errors.data.errors, [], 'No browser errors');
  const audit = JSON.parse(browser('a11y', '--json'));
  assert.equal(audit.success, true);
  writeFileSync(join(out, 'a11y.json'), JSON.stringify(audit, null, 2));
  assert.equal(audit.data.counts.violations, 0, 'Dark overview accessibility');
  browser('click', refFor('Mudar para o modo claro'));
  browser('set', 'viewport', '1440', '1000');
  browser('screenshot', join(out, 'desktop-light.png'), '--full');
  const lightAudit = JSON.parse(browser('a11y', '--json'));
  assert.equal(lightAudit.success, true);
  writeFileSync(
    join(out, 'a11y-light.json'),
    JSON.stringify(lightAudit, null, 2)
  );
  assert.equal(
    lightAudit.data.counts.violations,
    0,
    'Light overview accessibility'
  );
  const network = browser('network', 'requests');
  assert.ok(
    !/\) (?:4\d\d|5\d\d)\b/.test(network),
    'No failed browser requests'
  );
  pass(
    'Light/dark accessibility audits without violations and no failed network requests'
  );
  pass('Overview on mobile without horizontal overflow or browser errors');
  await verifyPlanCatalog({
    admin,
    operator,
    tenant,
    limited,
    identity,
    request,
    browser,
    refFor,
    snapshot,
    noOverflow,
    pass,
    unwrap,
    base,
    out,
  });
  checkBrowserErrors('plan catalog');
  browser('open', `${base}/platform`);
  browser('wait', '--text', 'Uma visão consolidada das empresas no SempreCRM.');
  browser('click', refFor('Bloquear painel'));
  browser('wait', '--url', '**/platform/login');
  assert.ok(!snapshot().includes('Navegação da plataforma'));
  const crmAfterLock = browser(
    'eval',
    "document.cookie.split(';').map(c => c.split('=')[0]).includes('sb-semprecrm-auth-token')"
  ).trim();
  assert.equal(
    crmAfterLock,
    'true',
    'Locking the panel preserves the CRM session'
  );
  pass('Lock panel returns to second login while preserving CRM session');
  writeFileSync(
    join(out, 'results.json'),
    JSON.stringify({ checks, verifiedAt: new Date().toISOString() }, null, 2)
  );
} catch (error) {
  console.error('Verification failed:', error.message);
  throw error;
} finally {
  try {
    browser('close');
  } catch {
    /* Browser may not have started. */
  }
  rmSync(browserOutput, { force: true });
  // Only delete fixtures created by this run, never pre-existing local data.
  if (accountIds.length)
    unwrap(await admin.from('leads').delete().in('account_id', accountIds));
  if (accountIds.length)
    unwrap(await admin.from('accounts').delete().in('id', accountIds));
  for (const id of users) unwrap(await admin.auth.admin.deleteUser(id));
}
