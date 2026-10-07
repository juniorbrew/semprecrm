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

const env = verificationEnv();
assert.equal(env.SUPABASE_INTERNAL_URL, 'http://127.0.0.1:57021');
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
  const email = `overview-${label}-${randomUUID()}@example.test`;
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
