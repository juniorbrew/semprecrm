// Local verification only. Never reads or changes remote Supabase projects.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import webpush from 'web-push';

export const workdir =
  process.env.LEADS_TEST_WORKDIR ||
  join(tmpdir(), 'semprecrm-leads-verification');
export function verificationEnv() {
  const cli = process.env.SUPABASE_CLI;
  if (!cli)
    throw new Error('Set SUPABASE_CLI to the local Supabase CLI executable');
  const status = JSON.parse(
    execFileSync(cli, ['status', '--workdir', workdir, '-o', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  );
  if (status.API_URL !== 'http://127.0.0.1:57021')
    throw new Error('Refusing non-isolated Supabase URL');
  const keyPath = join(workdir, 'test-vapid.json');
  mkdirSync(workdir, { recursive: true });
  if (!existsSync(keyPath))
    writeFileSync(keyPath, JSON.stringify(webpush.generateVAPIDKeys()));
  const vapid = JSON.parse(readFileSync(keyPath, 'utf8'));
  return {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: '/supabase',
    SUPABASE_INTERNAL_URL: status.API_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: status.ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    AUTOMATION_CRON_SECRET: 'local-leads-verification-only',
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: 'mailto:test@example.test',
    ENCRYPTION_KEY: '0'.repeat(64),
    META_APP_SECRET: 'local-verification-only',
    NEXT_PUBLIC_APP_URL: 'http://127.0.0.1:3107',
    ...(existsSync(join(workdir, 'push-cert.pem'))
      ? { NODE_EXTRA_CA_CERTS: join(workdir, 'push-cert.pem') }
      : {}),
  };
}

if (process.argv[1]?.endsWith('platform-leads-runtime.mjs')) {
  const command = process.argv[2] || 'dev';
  if (!['dev', 'build', 'start'].includes(command))
    throw new Error('Expected dev, build or start');
  const child = spawn(
    process.execPath,
    [
      'node_modules/next/dist/bin/next',
      command,
      ...(command === 'build' ? [] : ['-p', '3107']),
    ],
    {
      env: verificationEnv(),
      stdio: 'inherit',
      windowsHide: true,
    }
  );
  child.on('exit', (code) => process.exit(code ?? 1));
}
