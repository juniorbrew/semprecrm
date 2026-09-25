import path from "node:path";

export interface GatewayConfig {
  port: number;
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
  return {
    port,
    secret,
    appUrl: required(env, "APP_URL").replace(/\/+$/, ""),
    supabaseUrl: required(env, "SUPABASE_URL").replace(/\/+$/, ""),
    supabasePublicUrl: (env.SUPABASE_PUBLIC_URL?.trim() || required(env, "SUPABASE_URL")).replace(/\/+$/, ""),
    supabaseServiceRoleKey: required(env, "SUPABASE_SERVICE_ROLE_KEY"),
    dataDir: path.resolve(env.WA_DATA_DIR?.trim() || "./data"),
    logLevel: env.LOG_LEVEL?.trim() || "info",
    markOnline: !/^(false|0|no|off)$/i.test(env.WA_MARK_ONLINE?.trim() ?? ""),
  };
}
