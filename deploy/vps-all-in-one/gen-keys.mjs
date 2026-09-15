#!/usr/bin/env node
// Gera todos os segredos que o Supabase self-hosted precisa e imprime linhas
// prontas para colar no /opt/supabase/.env. Sem dependências: só node >= 18.
//   node deploy/vps-all-in-one/gen-keys.mjs
import { randomBytes, createHmac } from "node:crypto";

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const hex = (n) => randomBytes(n).toString("hex");

const JWT_SECRET = hex(32); // 64 chars, >= 32 exigidos pelo GoTrue
const iat = Math.floor(Date.now() / 1000);
const exp = iat + 60 * 60 * 24 * 365 * 10; // 10 anos, igual ao padrão do Supabase

function jwt(role) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ role, iss: "supabase", iat, exp }));
  const sig = createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

const out = {
  POSTGRES_PASSWORD: hex(24),
  JWT_SECRET,
  ANON_KEY: jwt("anon"),
  SERVICE_ROLE_KEY: jwt("service_role"),
  DASHBOARD_USERNAME: "admin",
  DASHBOARD_PASSWORD: hex(16),
  SECRET_KEY_BASE: hex(32),
  REALTIME_DB_ENC_KEY: hex(8), // exatamente 16 chars
  VAULT_ENC_KEY: hex(16), // exatamente 32 chars
  PG_META_CRYPTO_KEY: hex(16),
  LOGFLARE_PUBLIC_ACCESS_TOKEN: hex(24),
  LOGFLARE_PRIVATE_ACCESS_TOKEN: hex(24),
  S3_PROTOCOL_ACCESS_KEY_ID: hex(16),
  S3_PROTOCOL_ACCESS_KEY_SECRET: hex(32),
  POOLER_TENANT_ID: "semprecrm",
  // Chave do app (WhatsApp token encryption) — vai no .env.production do Next, não no Supabase.
  ENCRYPTION_KEY_DO_APP: hex(32),
};

for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
console.error("\nGuarde este bloco em local seguro. Ele não é reproduzível.");
