import path from "node:path";
import { httpOrigin, type MediaPolicy } from "./outbound-media.js";
import { DEFAULT_SEND_QUEUE, type SendQueueConfig } from "./send-queue.js";

export interface GatewayConfig {
  port: number;
  /**
   * Endereço em que o HTTP escuta (GATEWAY_BIND, padrão 127.0.0.1). O deploy
   * PM2 roda no mesmo host do app, então loopback basta; containers que são
   * chamados por outro serviço da rede Docker precisam de GATEWAY_BIND=0.0.0.0.
   */
  bind: string;
  secret: string;
  appUrl: string;
  supabaseUrl: string;
  /**
   * Base das URLs públicas de mídia gravadas no banco. Igual a `supabaseUrl`
   * salvo quando o gateway alcança o Supabase por outra rota (ex.: Docker,
   * `SUPABASE_URL=http://host.docker.internal:56021` e
   * `SUPABASE_PUBLIC_URL=http://192.168.1.10:56021` para os navegadores).
   *
   * Pode ser apenas um CAMINHO (`SUPABASE_PUBLIC_URL=/supabase`) quando o
   * app expõe o Supabase pela própria origem (nginx faz proxy de
   * `/supabase/*`): as URLs gravadas ficam relativas à origem
   * (`/supabase/storage/v1/object/public/...`) e funcionam de localhost, IP
   * da LAN ou VPN. O app absolutiza a URL antes de pedir um envio de mídia,
   * então o gateway sempre recebe `http(s)://...` em `media.url`.
   */
  supabasePublicUrl: string;
  supabaseServiceRoleKey: string;
  dataDir: string;
  logLevel: string;
  /**
   * Fica "online" ao conectar (WA_MARK_ONLINE, padrão true). O Baileys só
   * devolve a confirmação de entrega normal (✓✓ no celular do cliente)
   * quando a sessão está online; offline ele manda um recibo "inactive" e
   * o cliente vê só ✓ enquanto o celular principal estiver sem conexão.
   * Efeito colateral: com uma sessão online o WhatsApp não notifica o
   * celular principal. `WA_MARK_ONLINE=false` volta ao comportamento antigo.
   */
  markOnline: boolean;
  /**
   * De onde o gateway aceita baixar mídia para enviar: sempre as origens do
   * storage (SUPABASE_URL / SUPABASE_PUBLIC_URL, quando absoluta) mais as de
   * MEDIA_ALLOWED_ORIGINS (lista separada por vírgula, ex.
   * `https://cdn.exemplo.com`) — essas extras não podem apontar para rede interna.
   */
  mediaPolicy: MediaPolicy;
  /**
   * Fila anti-banimento dos envios (ver send-queue.ts): envios `bulk` saem
   * espaçados e com teto por minuto; `interactive` nunca espera.
   */
  sendQueue: SendQueueConfig;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} inválida (inteiro >= ${min}): ${raw}`);
  return n;
}

const flag = (v: string | undefined, fallback: boolean) =>
  v?.trim() ? !/^(false|0|no|off)$/i.test(v.trim()) : fallback;

function loadSendQueue(env: NodeJS.ProcessEnv): SendQueueConfig {
  const d = DEFAULT_SEND_QUEUE;
  const delayMinMs = intEnv(env, "WA_BULK_DELAY_MIN_MS", d.delayMinMs, 0);
  const delayMaxMs = intEnv(env, "WA_BULK_DELAY_MAX_MS", d.delayMaxMs, 0);
  if (delayMaxMs < delayMinMs) throw new Error("WA_BULK_DELAY_MAX_MS não pode ser menor que WA_BULK_DELAY_MIN_MS");
  const maxWaitMs = intEnv(env, "WA_BULK_MAX_WAIT_MS", d.maxWaitMs, 1000);
  return {
    enabled: flag(env.WA_SEND_QUEUE, d.enabled),
    delayMinMs,
    delayMaxMs,
    maxPerMinute: intEnv(env, "WA_BULK_MAX_PER_MINUTE", d.maxPerMinute, 1),
    maxQueue: intEnv(env, "WA_BULK_MAX_QUEUE", d.maxQueue, 1),
    maxWaitMs,
    typingEnabled: flag(env.WA_BULK_TYPING, d.typingEnabled),
    typingMsPerChar: intEnv(env, "WA_TYPING_MS_PER_CHAR", d.typingMsPerChar, 0),
    typingMaxMs: intEnv(env, "WA_TYPING_MAX_MS", d.typingMaxMs, 0),
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return value;
}

/**
 * Lê a configuração do ambiente. Falha cedo (na subida do processo) quando
 * algo obrigatório está faltando, em vez de quebrar no primeiro request.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const port = Number.parseInt(env.WA_GATEWAY_PORT ?? "3201", 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`WA_GATEWAY_PORT inválida: ${env.WA_GATEWAY_PORT}`);
  }
  const secret = required(env, "WA_GATEWAY_SECRET");
  if (secret.length < 16) {
    throw new Error("WA_GATEWAY_SECRET precisa ter pelo menos 16 caracteres");
  }
  const supabaseUrl = required(env, "SUPABASE_URL").replace(/\/+$/, "");
  const supabasePublicUrl = (env.SUPABASE_PUBLIC_URL?.trim() || supabaseUrl).replace(/\/+$/, "");
  const extraOrigins = (env.MEDIA_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((raw) => {
      const origin = httpOrigin(raw);
      if (!origin) throw new Error(`MEDIA_ALLOWED_ORIGINS inválida: ${raw}`);
      return origin;
    });
  const storageOrigins = [...new Set([supabaseUrl, supabasePublicUrl].map(httpOrigin).filter((o): o is string => !!o))];
  return {
    port,
    bind: env.GATEWAY_BIND?.trim() || "127.0.0.1",
    secret,
    appUrl: required(env, "APP_URL").replace(/\/+$/, ""),
    supabaseUrl,
    supabasePublicUrl,
    supabaseServiceRoleKey: required(env, "SUPABASE_SERVICE_ROLE_KEY"),
    dataDir: path.resolve(env.WA_DATA_DIR?.trim() || "./data"),
    logLevel: env.LOG_LEVEL?.trim() || "info",
    markOnline: !/^(false|0|no|off)$/i.test(env.WA_MARK_ONLINE?.trim() ?? ""),
    mediaPolicy: { storageOrigins, extraOrigins },
    sendQueue: loadSendQueue(env),
  };
}
