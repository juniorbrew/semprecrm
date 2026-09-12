import { serve } from "@hono/node-server";
import { AppClient, HEADER_SECRET } from "./app-client.js";
import { loadConfig, type GatewayConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { MediaStore } from "./media.js";
import { GatewayError, SessionManager } from "./session-manager.js";
import { createApp } from "./server.js";

async function main(): Promise<void> {
  let config: GatewayConfig;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`[wa-gateway] ${(err as Error).message}`);
    process.exit(1);
  }
  const logger: Logger = createLogger(config.logLevel);

  const appClient = new AppClient({ appUrl: config.appUrl, secret: config.secret, logger });
  const mediaStore = new MediaStore({
    supabaseUrl: config.supabaseUrl,
    serviceRoleKey: config.supabaseServiceRoleKey,
    logger,
  });
  const sessions = new SessionManager({ dataDir: config.dataDir, appClient, mediaStore, logger });

  const app = createApp({ secret: config.secret, sessions, logger });
  const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
    logger.info({ port: info.port, dataDir: config.dataDir, appUrl: config.appUrl }, "wa-gateway no ar");
  });

  const resumed = await sessions.resumeAll();
  if (resumed.length) logger.info({ accounts: resumed }, "sessões retomadas do disco");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "encerrando");
    await sessions.shutdown();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason instanceof Error ? reason.message : String(reason) }, "unhandledRejection");
  });
}

export { GatewayError, HEADER_SECRET };

void main();
