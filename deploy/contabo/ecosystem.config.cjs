// PM2 process file for a single-VPS deploy (Contabo, Hetzner, any Ubuntu box).
// Usage on the server:  pm2 start deploy/contabo/ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [
    {
      name: "semprecrm",
      cwd: "/var/www/semprecrm",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3000",
      instances: 1, // keep 1: the in-memory rate limiter assumes a single process
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "768M",
      env: { NODE_ENV: "production", PORT: "3000" },
      // Real secrets live in /var/www/semprecrm/.env.production (chmod 600),
      // which Next reads on `next start`. Nothing sensitive goes in this file.
      out_file: "/var/log/semprecrm/out.log",
      error_file: "/var/log/semprecrm/err.log",
      merge_logs: true,
      time: true,
    },
    {
      // Gateway do canal WhatsApp por QR code (Baileys). Fala só com o app
      // via HTTP interno na 3201 — nunca exponha essa porta no nginx.
      name: "wa-gateway",
      cwd: "/var/www/semprecrm/services/wa-gateway",
      script: "dist/index.js",
      // Segredos ficam em services/wa-gateway/.env (chmod 600); o Node 20 lê
      // o arquivo direto com --env-file, sem depender do PM2.
      node_args: "--env-file=/var/www/semprecrm/services/wa-gateway/.env",
      instances: 1, // obrigatório: cada sessão do WhatsApp vive em um único processo
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "512M",
      // Credenciais das sessões (uma pasta por account_id). Fora do checkout do
      // git para sobreviver a redeploys; está no backup.sh.
      env: { NODE_ENV: "production", WA_DATA_DIR: "/var/lib/semprecrm/wa" },
      out_file: "/var/log/semprecrm/wa-gateway.out.log",
      error_file: "/var/log/semprecrm/wa-gateway.err.log",
      merge_logs: true,
      time: true,
    },
    {
      // Agendador interno (scripts/cron-tick.mjs): a cada minuto chama
      // /api/automations/cron e /api/flows/cron no próprio app, por loopback.
      // Sem ele as etapas "Aguardar", os gatilhos por horário/inatividade e os
      // timeouts dos flows não andam. Lê AUTOMATION_CRON_SECRET do mesmo
      // .env.production do app; APP_URL aponta para a porta local do Next.
      name: "semprecrm-cron",
      cwd: "/var/www/semprecrm",
      script: "scripts/cron-tick.mjs",
      node_args: "--env-file=/var/www/semprecrm/.env.production",
      instances: 1, // um só: dois tickers dobrariam as chamadas
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "128M",
      env: { NODE_ENV: "production", APP_URL: "http://127.0.0.1:3000", CRON_INTERVAL_MS: "60000" },
      out_file: "/var/log/semprecrm/cron.out.log",
      error_file: "/var/log/semprecrm/cron.err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
