import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect, it } from 'vitest';

it.skipIf(process.env.PLAN_CATALOG_INTEGRATION !== '1')(
  'real assigned permissions deny automation effects and permit an explicit override',
  async () => {
    const cli = process.env.SUPABASE_CLI;
    const workdir = process.env.LEADS_TEST_WORKDIR;
    if (!cli || !workdir) throw new Error('Isolated Supabase runtime required');
    const status = JSON.parse(
      execFileSync(cli, ['status', '--workdir', workdir, '-o', 'json'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    );
    expect(['http://127.0.0.1:57021', 'http://127.0.0.1:58021']).toContain(
      status.API_URL
    );
    process.env.SUPABASE_INTERNAL_URL = status.API_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = status.SERVICE_ROLE_KEY;
    const db = createClient(status.API_URL, status.SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
    const unwrap = <T>({ data, error }: { data: T; error: unknown }) => {
      if (error) throw new Error('Isolated fixture operation failed');
      return data;
    };
    const createdUser = await db.auth.admin.createUser({
      email: `plan-engine-${randomUUID()}@example.test`,
      password: randomUUID(),
      email_confirm: true,
    });
    if (createdUser.error) throw new Error('Synthetic user creation failed');
    const user = createdUser.data.user;
    if (!user) throw new Error('Missing synthetic user');
    let accountId: string | null = null;
    try {
      const accountRow = unwrap(
        await db
          .from('accounts')
          .select('id')
          .eq('owner_user_id', user.id)
          .single()
      );
      if (!accountRow) throw new Error('Missing synthetic account');
      accountId = accountRow.id;
      const versions = unwrap(await db.rpc('public_plan_catalog'));
      const current = versions.find((v: { plan: string }) => v.plan === 'pro');
      unwrap(
        await db
          .from('accounts')
          .update({
            plan: 'pro',
            plan_status: 'active',
            plan_version_id: current.id,
            module_overrides: { automations: false, tasks: true },
          })
          .eq('id', accountId)
      );
      const rule = unwrap(
        await db
          .from('automations')
          .insert({
            account_id: accountId,
            user_id: user.id,
            name: 'Synthetic plan gate',
            trigger_type: 'new_contact_created',
            is_active: true,
            run_frequency: 'every_time',
          })
          .select('id')
          .single()
      );
      if (!rule) throw new Error('Missing synthetic automation');
      unwrap(
        await db.from('automation_steps').insert({
          automation_id: rule.id,
          step_type: 'create_task',
          position: 0,
          step_config: { title: 'Synthetic granted task' },
        })
      );
      const { runAutomationsForTrigger } = await import('./engine');
      expect(
        await runAutomationsForTrigger({
          accountId: accountId!,
          triggerType: 'new_contact_created',
        })
      ).toMatchObject({ ok: true });
      expect(
        unwrap(await db.from('tasks').select('id').eq('account_id', accountId))
      ).toHaveLength(0);
      expect(
        unwrap(
          await db
            .from('automation_logs')
            .select('id')
            .eq('automation_id', rule.id)
        )
      ).toHaveLength(0);
      unwrap(
        await db
          .from('accounts')
          .update({ module_overrides: { automations: true, tasks: true } })
          .eq('id', accountId)
      );
      expect(
        await runAutomationsForTrigger({
          accountId: accountId!,
          triggerType: 'new_contact_created',
        })
      ).toMatchObject({ ok: true });
      expect(
        unwrap(await db.from('tasks').select('id').eq('account_id', accountId))
      ).toHaveLength(1);
    } finally {
      if (accountId) {
        unwrap(await db.from('leads').delete().eq('account_id', accountId));
        unwrap(await db.from('accounts').delete().eq('id', accountId));
      }
      const removedUser = await db.auth.admin.deleteUser(user.id);
      if (removedUser.error) throw new Error('Synthetic user cleanup failed');
    }
  },
  30_000
);
