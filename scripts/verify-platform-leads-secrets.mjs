// Read private values without ever printing them; inspect browser-delivered assets.
import assert from 'node:assert/strict';
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { verificationEnv } from './platform-leads-runtime.mjs';

const privateName =
  /SERVICE_ROLE|PRIVATE_KEY|CRON_SECRET|ENCRYPTION_KEY|DATABASE_URL|DB_PASSWORD|META_APP_SECRET/;
const values = new Map();
for (const [name, value] of Object.entries(verificationEnv())) {
  if (privateName.test(name) && value?.length >= 16) values.set(name, value);
}
const raw = existsSync('.env.local') ? readFileSync('.env.local', 'utf8') : '';
for (const line of raw.split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match && privateName.test(match[1])) {
    const value = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (value.length >= 16) values.set(`local_${match[1]}`, value);
  }
}
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]
  );
}
const assets = files('.next/static').filter((path) =>
  /\.(js|html|map|json)$/.test(path)
);
assert.ok(assets.length > 0);
const findings = [];
for (const path of assets) {
  const text = readFileSync(path, 'utf8');
  for (const [name, value] of values) {
    if (text.includes(value)) findings.push({ path, name });
  }
}
mkdirSync('docs/verification/platform-leads', { recursive: true });
writeFileSync(
  'docs/verification/platform-leads/secrets-results.json',
  JSON.stringify(
    {
      at: new Date().toISOString(),
      assets: assets.length,
      privateValuesChecked: values.size,
      findings,
    },
    null,
    2
  )
);
assert.deepEqual(
  findings,
  [],
  'Private value found in browser assets (report contains names only)'
);
console.log(
  `PASS frontend secrets: ${assets.length} assets, ${values.size} private values, zero matches`
);
