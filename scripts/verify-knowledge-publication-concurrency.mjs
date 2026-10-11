import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// Only the local development container; fixtures are created and removed by this test.
const container = 'supabase_db_semprecrm';
const args = ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate'];
const sql = (query) => execFileSync('docker', args, { input: query, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const user = randomUUID();
let account;
let item;
const session = (query) => {
  const child = spawn('docker', args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', data => { err += data; });
  child.stdin.end(query);
  return new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve({ code, err })); });
};
const auth = `SET ROLE authenticated; SET request.jwt.claim.sub='${user}';`;
const save = (label) => `SELECT public.ai_knowledge_save_item('${account}','${item}','text','Delivery ${label}',NULL,'Prazo entrega ${label} primeiro trecho. Prazo entrega ${label} segundo trecho.',NULL,ARRAY['Prazo entrega ${label} primeiro trecho.','Prazo entrega ${label} segundo trecho.']);`;
const publish = (version) => `SELECT public.ai_knowledge_publish_item('${account}','${item}',${version});`;
const waitLocked = async (label) => {
  for (let n = 0; n < 60; n++) {
    if (sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${label}' AND wait_event='PgSleep';`) === '1') return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error('Lock holder never reached the test barrier');
};
const locked = (label, query) => session(`BEGIN; SET application_name='${label}'; ${auth} ${query} SELECT pg_sleep(1.5); COMMIT;`);
const ok = (result) => assert.equal(result.code, 0, result.err);
try {
  sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES ('${user}','kb-race-${user}@example.test','{"full_name":"KB race test"}');`);
  account = sql(`SELECT account_id FROM public.profiles WHERE user_id='${user}';`);
  item = sql(`BEGIN; ${auth} SELECT public.ai_knowledge_save_item('${account}',NULL,'text','Delivery one',NULL,'Prazo entrega one primeiro trecho. Prazo entrega one segundo trecho.',NULL,ARRAY['Prazo entrega one primeiro trecho.','Prazo entrega one segundo trecho.']); COMMIT;`);
  assert.match(item, /^[0-9a-f-]{36}$/);
  sql(`BEGIN; ${auth} ${publish(1)} COMMIT;`);
  const first = locked('kb_save_first', save('two'));
  await waitLocked('kb_save_first');
  const stale = session(`BEGIN; ${auth} ${publish(1)} COMMIT;`);
  ok(await first);
  const staleResult = await stale;
  assert.notEqual(staleResult.code, 0); assert.match(staleResult.err, /40001/);
  const publishing = locked('kb_publish_first', publish(2));
  await waitLocked('kb_publish_first');
  const edit = session(`BEGIN; ${auth} ${save('three')} COMMIT;`);
  ok(await publishing); ok(await edit);
  assert.equal(sql(`SELECT published_version||':'||latest_version FROM public.ai_knowledge_items WHERE id='${item}';`), '2:3');
  const saveA = locked('kb_parallel_save', save('four'));
  await waitLocked('kb_parallel_save');
  const saveB = session(`BEGIN; ${auth} ${save('five')} COMMIT;`);
  ok(await saveA); ok(await saveB);
  assert.equal(sql(`SELECT count(*) FROM public.ai_knowledge_item_versions WHERE item_id='${item}';`), '5');
  const switching = locked('kb_search_publication', publish(5));
  await waitLocked('kb_search_publication');
  for (let n = 0; n < 8; n++) {
    const coherent = sql(`SELECT count(*)=2 AND count(DISTINCT title)=1 AND bool_and((title='Delivery two' AND content LIKE 'Prazo entrega two %') OR (title='Delivery five' AND content LIKE 'Prazo entrega five %')) FROM public.ai_knowledge_search_service('${account}','prazo entrega',5);`);
    assert.equal(coherent, 't');
  }
  ok(await switching);
  const deleting = locked('kb_delete_publication', publish(5));
  await waitLocked('kb_delete_publication');
  const deletion = session(`BEGIN; ${auth} DELETE FROM public.ai_knowledge_items WHERE id='${item}'; COMMIT;`);
  ok(await deleting); ok(await deletion);
  assert.equal(sql(`SELECT count(*) FROM public.ai_knowledge_item_versions WHERE item_id='${item}';`), '0');
  console.log('PASS: save/publish in both orders, consecutive concurrent versions, coherent concurrent search, publish/delete cascade');
} finally {
  if (account) sql(`DELETE FROM public.accounts WHERE id='${account}';`);
  sql(`DELETE FROM auth.users WHERE id='${user}';`);
}
