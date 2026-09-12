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
  ],
};
