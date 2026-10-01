# Segurança / Security

## Como reportar uma vulnerabilidade

**Não abra issue pública.** Use o reporte privado do GitHub:
[Security → Report a vulnerability](https://github.com/juniorbrew/semprecrm/security/advisories/new).
Inclua descrição e impacto, passos para reproduzir e o commit testado. Respondemos em até 72 horas e
combinamos a divulgação depois da correção.

## How to report a vulnerability

**Do not open a public issue.** Use GitHub private reporting:
[Security → Report a vulnerability](https://github.com/juniorbrew/semprecrm/security/advisories/new).
Include a description and impact, reproduction steps and the commit you tested. We reply within 72 hours
and coordinate disclosure after the fix.

Vulnerabilities in upstream projects (Supabase, Next.js, Node.js, Baileys) go to their maintainers.

## Checklist de implantação / Deployment hardening checklist

Guia completo: `deploy/vps-all-in-one/README.md` e `deploy/contabo/README.md`. Rotina mensal:
`docs/runbooks/ops-checklist.md`.

- **Firewall:** só 22, 80 e 443 abertas (`ufw`). SSH só com chave.
- **Docker ignora o ufw / Docker bypasses ufw:** porta publicada por container fica aberta mesmo com
  `ufw deny`. Publique só em `127.0.0.1` (o instalador faz isso para 8000, 5432 e 6543) e confira com
  `ss -ltn` depois de todo `docker compose up`.
- **Binds em loopback / loopback binds:** Next (3000), wa-gateway (3201, `GATEWAY_BIND=127.0.0.1`),
  gateway do Supabase (8000) e Supavisor (5432/6543). Studio só por túnel SSH ou IP liberado no Nginx.
- **Backups cifrados e fora da VPS / encrypted offsite backups:** `backup.sh` com `BACKUP_AGE_RECIPIENT` e
  `BACKUP_RCLONE_REMOTE`; chave privada age fora do servidor; `backup-check.sh` sem erro; restauração
  testada de tempos em tempos.
- **Arquivos de segredo com modo 600 / secret files mode 600:** `.env.production`,
  `services/wa-gateway/.env`, `/opt/supabase/.env`, `/etc/semprecrm/backup.env`.
- **`ENCRYPTION_KEY`:** cifra tokens do WhatsApp, chaves de IA e tokens de agenda no banco. O app não lê
  duas chaves ao mesmo tempo, então trocar a chave invalida esses valores: depois da troca é preciso
  recadastrar o token do WhatsApp, as chaves de IA e reconectar as agendas. Troque só se houver suspeita de
  vazamento, guarde a chave antiga até concluir e nunca a perca (sem ela os dados cifrados são
  irrecuperáveis). / Rotating it invalidates every value encrypted with the old key; re-enter those secrets
  after the swap.
- **Dependências / dependencies:** `npm audit --omit=dev` limpo; `deploy.sh` instala com
  `--ignore-scripts` e usa a CLI do Supabase em versão fixa.
