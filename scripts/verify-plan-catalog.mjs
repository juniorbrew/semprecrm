import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Receives only this harness's isolated clients and synthetic identities.
export async function verifyPlanCatalog({
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
}) {
  const initial = unwrap(await admin.rpc('public_plan_catalog')).find(
    (v) => v.plan === 'pro'
  );
  const adminUser = unwrap(
    await admin
      .from('profiles')
      .select('user_id')
      .eq('account_id', operator.account.id)
      .single()
  ).user_id;
  const post = (path, body, who = operator) =>
    request(path, who, { method: 'PATCH', body: JSON.stringify(body) });
  const company = () =>
    admin
      .from('accounts')
      .select('plan_version_id,module_overrides,limit_overrides,plan_status')
      .eq('id', tenant.account.id)
      .single()
      .then(unwrap);
  const before = await company();
  try {
    for (const who of [
      null,
      tenant,
      {
        ...operator,
        cookies: operator.cookies.filter((c) => c.name !== 'sc-platform-gate'),
      },
    ]) {
      const res = await post(
        '/api/platform/plans/pro',
        {
          expected_version_id: initial.id,
          definition: initial.definition,
          price_monthly_cents: 9990,
        },
        who
      );
      assert.ok([401, 403].includes(res.status));
    }
    browser('open', `${base}/platform/plans/pro`);
    browser('wait', '--text', 'Preço mensal anunciado');
    if (snapshot().includes('Mudar para o modo escuro'))
      browser('click', refFor('Mudar para o modo escuro'));
    assert.ok(snapshot().includes('Planos'));
    browser('fill', '#plan-max_users', '1.5');
    assert.match(snapshot(), /Salvar condições.*disabled/);
    browser('fill', '#plan-max_users', '20');
    browser('fill', '#plan-max_channels', '3');
    browser('fill', '#plan-price', '99,90');
    browser('click', refFor('Salvar condições'));
    browser(
      'wait',
      '--text',
      'Condições salvas. As empresas existentes mantêm suas versões.'
    );
    const edited = unwrap(await admin.rpc('public_plan_catalog')).find(
      (v) => v.plan === 'pro'
    );
    assert.equal(edited.price_monthly_cents, 9990);
    assert.deepEqual(edited.definition.limits, {
      max_users: 20,
      max_channels: 3,
    });
    assert.deepEqual(await company(), before);
    browser('click', refFor('Ver histórico de versões'));
    browser('wait', '--text', 'Condições iniciais');
    assert.ok(
      browser('get', 'text', 'body').includes(`Versão ${initial.revision}`)
    );
    pass(
      'Catalog editor saves BRL cents, rejects fractional limits and preserves existing assignments'
    );
    for (const width of [1440, 375]) {
      browser('set', 'viewport', String(width), '1000');
      assert.ok(noOverflow());
      browser(
        'screenshot',
        join(out, `plan-editor-${width}-dark.png`),
        '--full'
      );
      const audit = JSON.parse(browser('a11y', '--json'));
      writeFileSync(
        join(out, `plan-editor-a11y-${width}-dark.json`),
        JSON.stringify(audit, null, 2)
      );
      assert.equal(audit.data.counts.violations, 0);
    }
    browser('click', refFor('Mudar para o modo claro'));
    for (const width of [1440, 375]) {
      browser('set', 'viewport', String(width), '1000');
      assert.ok(noOverflow());
      browser(
        'screenshot',
        join(out, `plan-editor-${width}-light.png`),
        '--full'
      );
      const audit = JSON.parse(browser('a11y', '--json'));
      writeFileSync(
        join(out, `plan-editor-a11y-${width}-light.json`),
        JSON.stringify(audit, null, 2)
      );
      assert.equal(audit.data.counts.violations, 0);
    }
    browser('click', refFor('Mudar para o modo escuro'));
    const advertised = await (await request('/precos')).text();
    assert.ok(advertised.includes('99,90'));
    const newer = await identity('Novo contrato', false, {
      plan: 'pro',
      plan_status: 'active',
    });
    assert.equal(
      unwrap(
        await admin
          .from('accounts')
          .select('plan_version_id')
          .eq('id', newer.account.id)
          .single()
      ).plan_version_id,
      edited.id
    );
    const statusSave = await post(
      `/api/platform/accounts/${tenant.account.id}`,
      { plan_status: 'active' }
    );
    assert.equal(statusSave.status, 200);
    assert.equal(
      (await statusSave.json()).account.plan_version_id,
      before.plan_version_id
    );
    const simultaneous = await Promise.all(
      [9991, 9992].map((price) =>
        post('/api/platform/plans/pro', {
          expected_version_id: edited.id,
          definition: edited.definition,
          price_monthly_cents: price,
        })
      )
    );
    assert.deepEqual(simultaneous.map((r) => r.status).sort(), [200, 409]);
    browser('fill', '#plan-price', '101,00');
    browser('click', refFor('Salvar condições'));
    browser('wait', '--text', 'O plano foi alterado por outra pessoa.');
    assert.equal(browser('get', 'value', '#plan-price').trim(), '101,00');
    browser(
      'click',
      refFor('Recarregar condições atuais e descartar rascunho')
    );
    const current = unwrap(await admin.rpc('public_plan_catalog')).find(
      (v) => v.plan === 'pro'
    );
    const retry = await post('/api/platform/plans/pro', {
      expected_version_id: current.id,
      definition: current.definition,
      price_monthly_cents: current.price_monthly_cents,
    });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).plan.id, current.id);
    assert.equal(
      (
        await post(`/api/platform/accounts/${limited.account.id}`, {
          adopt_current_plan: true,
          expected_plan_version_id: edited.id,
        })
      ).status,
      409
    );
    browser('open', `${base}/platform/${limited.account.id}`);
    browser('wait', '--text', 'Atualizar condições do plano');
    browser('click', refFor('Atualizar condições do plano'));
    browser('wait', '--text', 'Alterações após salvar');
    browser('click', refFor('Salvar alterações'));
    browser('wait', '--text', 'Conta atualizada');
    const adopted = unwrap(
      await admin
        .from('accounts')
        .select('plan_version_id,limit_overrides')
        .eq('id', limited.account.id)
        .single()
    );
    assert.equal(adopted.plan_version_id, current.id);
    assert.deepEqual(adopted.limit_overrides, { max_users: 1 });
    const history = await request(
      `/api/platform/accounts/${limited.account.id}/activity?section=history`,
      operator
    );
    assert.equal(history.status, 200);
    const historyPage = await history.json();
    assert.ok(historyPage.items.some((v) => v.plan_version_change));
    pass(
      'New contracts use current terms, status edits preserve grants, stale previews conflict and explicit adoption preserves overrides'
    );
    const reduced = unwrap(
      await admin.rpc('platform_save_plan_version', {
        p_plan: 'pro',
        p_expected_version_id: current.id,
        p_definition: {
          modules: ['channel_qr', 'lead_capture'],
          limits: { max_users: 0, max_channels: 0 },
        },
        p_price_monthly_cents: 9990,
        p_actor_user_id: adminUser,
      })
    )[0];
    browser('open', `${base}/platform/${tenant.account.id}`);
    browser('wait', '--text', 'Atualizar condições do plano');
    browser('click', refFor('Atualizar condições do plano'));
    browser('wait', '--text', 'O uso atual excede os limites propostos.');
    browser('click', refFor('Salvar alterações'));
    browser('wait', '--text', 'Conta atualizada');
    assert.equal((await company()).plan_version_id, reduced.id);
    const invite = await request('/api/account/invitations', tenant, {
      method: 'POST',
      body: JSON.stringify({ role: 'agent' }),
    });
    assert.equal(invite.status, 403);
    assert.equal((await invite.json()).code, 'plan_limit_reached');
    const channel = await request('/api/channels/qr/connect', tenant, {
      method: 'POST',
    });
    assert.equal(channel.status, 403);
    assert.equal((await channel.json()).code, 'plan_limit_reached');
    assert.equal(
      unwrap(
        await admin
          .from('profiles')
          .select('user_id')
          .eq('account_id', tenant.account.id)
      ).length,
      1
    );
    const hidden = await request('/api/platform/plans/pro/history', tenant);
    assert.equal(hidden.status, 403);
    const revisions = await (
      await request('/api/platform/plans/pro/history', operator)
    ).json();
    assert.ok(
      revisions.items.every(
        (v) => !('actor_user_id' in v) && !('currency' in v)
      )
    );
    assert.equal(
      (
        await post('/api/platform/plans/pro', {
          expected_version_id: reduced.id,
          definition: reduced.definition,
          price_monthly_cents: 100,
          actor_user_id: randomUUID(),
        })
      ).status,
      400
    );
    pass(
      'Actual invitation/channel routes enforce adopted zero capacity without removing existing users; history excludes private author IDs'
    );
    pass(
      'Plan editor has no desktop/mobile overflow and no light/dark accessibility violations'
    );
  } finally {
    const current = unwrap(await admin.rpc('public_plan_catalog')).find(
      (v) => v.plan === 'pro'
    );
    unwrap(
      await admin.rpc('platform_save_plan_version', {
        p_plan: 'pro',
        p_expected_version_id: current.id,
        p_definition: initial.definition,
        p_price_monthly_cents: initial.price_monthly_cents,
        p_actor_user_id: adminUser,
      })
    );
  }
}
