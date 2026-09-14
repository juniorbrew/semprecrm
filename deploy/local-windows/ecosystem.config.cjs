// PM2 process file for the LOCAL test server on Windows (this machine).
// Keeps the three dev services alive in the background, independent of any
// editor or Claude session, and brings them back at login (pm2-windows-startup).
//
//   npm install -g pm2 pm2-windows-startup
//   pm2-startup install
//   pm2 start deploy/local-windows/ecosystem.config.cjs && pm2 save
//
// Daily use:  pm2 status · pm2 logs semprecrm · pm2 restart all · pm2 stop all
// The app runs a PRODUCTION build (next start) to keep memory low on this
// machine (~300 MB vs ~2.4 GB for next dev). After code changes rebuild:
//   pm2 stop semprecrm && npm run build && pm2 restart semprecrm
// For hot reload during development run `npx next dev -p 3102` on the side.
// Ports: app 3101 (3100 is taken by Docker), gateway 3201, cron health 3301.
// Secrets stay in .env.local and services/wa-gateway/.env — nothing here.
const path = require("path");
const root = path.resolve(__dirname, "..", "..");

module.exports = {
  apps: [
    {
      name: "semprecrm",
      cwd: root,
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3101",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "768M",
      env: { NODE_ENV: "production" },
      time: true,
    },
    {
      // WhatsApp QR gateway (Baileys). tsx watch reloads on source changes and
      // reads services/wa-gateway/.env itself.
      name: "wa-gateway",
      cwd: path.join(root, "services", "wa-gateway"),
      script: "node_modules/tsx/dist/cli.mjs",
      args: "watch --env-file=.env src/index.ts",
      interpreter: "node",
      instances: 1, // one process per WhatsApp session, always
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "768M",
      time: true,
    },
    {
      // Internal scheduler: hits /api/automations/cron and /api/flows/cron
      // every minute. APP_URL / AUTOMATION_CRON_SECRET / CRON_HEALTH_PORT come
      // from .env.local.
      name: "cron-tick",
      cwd: root,
      script: "scripts/cron-tick.mjs",
      node_args: "--env-file=.env.local",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "128M",
      time: true,
    },
  ],
};
