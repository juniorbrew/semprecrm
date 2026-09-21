import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { verificationEnv } from '../../../scripts/platform-leads-runtime.mjs';

const env = verificationEnv();
const admin = createClient(env.SUPABASE_INTERNAL_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const email = `ui-critic-${Date.now()}@example.test`;
const password = 'Local-critic-847!';
const { data: { user }, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
assert.equal(error, null);
const { data: ownAccounts, error: accountsError } = await admin.from('accounts').select('id').eq('owner_user_id', user.id);
assert.equal(accountsError, null);
const accountIds = ownAccounts.map(account => account.id);
if (accountIds.length) assert.equal((await admin.from('leads').update({ notification_next_attempt_at: '2099-01-01T00:00:00Z' }).in('account_id', accountIds)).error, null);
assert.equal((await admin.from('platform_admins').insert({ user_id: user.id })).error, null);
let cookies = [];
const client = createServerClient(env.SUPABASE_INTERNAL_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  cookieOptions: { name: 'sb-semprecrm-auth-token' },
  cookies: { getAll: () => cookies, setAll: values => { cookies = values; } },
});
assert.equal((await client.auth.signInWithPassword({ email, password })).error, null);
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const browser = await chromium.launch({ headless: true });
const checks = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies(cookies.map(({ name, value }) => ({ name, value, domain: '127.0.0.1', path: '/' })));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto('http://127.0.0.1:3107/platform/leads');
    await page.getByRole('heading', { name: 'Leads', exact: true }).waitFor();
    await page.locator('html[data-mode]').waitFor();
    for (const mode of ['light', 'dark']) {
      if (await page.locator('html').getAttribute('data-mode') !== mode)
        await page.locator('header button[title]').click();
      await page.reload();
      await page.locator('html[data-mode]').waitFor();
      await page.locator('header button[title]').waitFor();
      assert.equal(await page.locator('html').getAttribute('data-mode'), mode);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: `docs/verification/platform-leads/critic-${width}-${mode}.png` });
      checks.push(`${width}px ${mode}: persisted reload, no overflow`);
    }
  }
  assert.deepEqual(errors, []);
  checks.push('Zero browser console errors and page errors across navigation, toggles and reloads');
  writeFileSync('docs/verification/platform-leads/critic-ui-results.json', JSON.stringify({ at: new Date().toISOString(), checks, errors }, null, 2));
  console.log(checks.join('\n'));
} finally {
  await browser.close();
  if (accountIds.length) await admin.from('leads').delete().in('account_id', accountIds);
  await admin.from('platform_admins').delete().eq('user_id', user.id);
  if (accountIds.length) await admin.from('accounts').delete().in('id', accountIds);
  await admin.auth.admin.deleteUser(user.id);
}
