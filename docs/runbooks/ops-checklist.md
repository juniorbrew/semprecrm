# Checklist mensal de operação

Rode na VPS (`ssh semprecrm`). Anote a data e qualquer desvio. Política de segurança: `.github/SECURITY.md`.

## 1. Backups

```bash
sudo bash /var/www/semprecrm/deploy/vps-all-in-one/backup-check.sh   # código 0 = ok
sudo tail -n 30 /var/log/semprecrm/backup.log                          # nenhum "BACKUP FALHOU"
sudo crontab -l | grep backup.sh                                       # chamado com /bin/bash
sudo rclone ls "$(sudo grep -oP '^BACKUP_RCLONE_REMOTE=\K.*' /etc/semprecrm/backup.env)" | tail -n 5
```

- [ ] `backup-check.sh` ok e cópias recentes no destino externo.
- [ ] A cada trimestre: restaurar o `db_*` mais novo num Postgres descartável (README, "Restaurar").

## 2. Dependências

No seu computador, no checkout atualizado:

```bash
npm audit --omit=dev
(cd services/wa-gateway && npm audit --omit=dev)
```

- [ ] Sem vulnerabilidade alta/crítica, ou com atualização agendada.
- [ ] PRs do Dependabot revisados.

## 3. Exposição de rede

```bash
sudo ss -ltnp | grep -vE '127\.0\.0\.1|\[::1\]'   # só sshd (22) e nginx (80/443)
sudo ufw status verbose
sudo nginx -t
curl -s -o /dev/null -w '%{http_code}\n' https://api.semprecrm.com.br/               # 403 (Studio fechado)
curl -s -o /dev/null -w '%{http_code}\n' https://www.semprecrm.com.br/api/flows/cron  # 403
```

- [ ] Nada além de 22/80/443 fora do loopback (Docker publica portas mesmo com ufw ativo).
- [ ] Configuração do Nginx em produção igual à do repositório (`deploy/contabo/nginx.conf`,
      `deploy/vps-all-in-one/nginx-api.conf`), salvo os nomes de host.

## 4. Segredos

```bash
sudo stat -c '%a %n' /var/www/semprecrm/.env.production /var/www/semprecrm/services/wa-gateway/.env \
  /opt/supabase/.env /etc/semprecrm/backup.env      # todos 600
```

- [ ] Modos 600.
- [ ] Rotação (a cada 6 meses ou quando alguém com acesso sair): `AUTOMATION_CRON_SECRET`,
      `WA_GATEWAY_SECRET` (app e gateway juntos), `DASHBOARD_PASSWORD` do Supabase, chave age dos backups
      (README, "Trocar as chaves"). `ENCRYPTION_KEY` só com suspeita de vazamento (ver `.github/SECURITY.md`).
- [ ] Atualizações do sistema: `sudo apt update && sudo apt list --upgradable`.
