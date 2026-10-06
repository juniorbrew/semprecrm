# Painel administrativo — entrega para publicação

Preparado em 06/10/2026 na branch local `codex/platform-admin-dashboard`, a partir de `origin/main` em `9ea7eabcb0a818b84463a3e03a872849263fded0`. Essa mesma revisão foi conferida no servidor de produção, cujo checkout estava limpo. A publicação depende da autorização do usuário.

## Entrega

- `/platform`: indicadores clicáveis de empresas, alertas de vencimento/capacidade, empresas recentes e atualização manual.
- `/platform/accounts`: busca, filtros de status, vencimento e limites, mantendo a ficha de edição existente.
- Navegação lateral no desktop e horizontal no celular, com Visão geral, Empresas e Leads.
- Temas claro/escuro e textos em português/inglês seguem o projeto.
- Segundo login, configuração de acesso e bloqueio do painel preservados. Contadores e navegação administrativa só são carregados com o painel desbloqueado; as páginas protegidas verificam a autorização antes de buscar empresas.
- Corrigida uma corrida de tradução preexistente na tela de Leads: os dois rótulos `Status` agora usam a tradução explícita e impedem a alteração externa do texto antes da hidratação. O erro foi reproduzido em desenvolvimento, que mostrou `Status` divergindo de `Situação`.

## Regras dos indicadores

Os status e permissões vêm das regras existentes de `resolveEntitlements`. Testes expirados não contam como testes operacionais. Vencimentos próximos abrangem sete dias; vencidos são separados. Datas inválidas e contas canceladas/suspensas não geram alerta de vencimento. Limites consideram ajustes individuais, convites pendentes e canais; limites ilimitados não geram alerta. Cada empresa conta uma vez no total que precisa de atenção.

## Verificação

- Suíte completa da base atual: 259 arquivos e 3.641 testes aprovados.
- Lint dos arquivos envolvidos e revisão independente de autorização e compatibilidade aprovados.
- Build final de produção, incluindo checagem de tipos, aprovado após a correção pontual de Leads.
- Harness `scripts/verify-platform-overview.mjs` com `agent-browser`, app real e Supabase local isolado. Evidências em `results.json`, `browser-errors.json`, `a11y.json`, `a11y-light.json` e capturas anexas.
- O harness valida acesso negado, segundo login, desbloqueio, bloqueio sem encerrar a sessão CRM, busca vazia, filtros, atualização, ficha, Leads e idioma dos rótulos corrigidos.
- Responsividade em 375, 640, 768 e 1440 pixels; rolagem horizontal somente dentro da tabela de empresas.
- Execução final em produção local: nove verificações aprovadas, nenhum erro de navegador ou requisição falha; axe sem violações nos temas claro e escuro. Rótulo e cabeçalho de Status conferidos em português e inglês.

Next.js pode responder HTTP 200 quando redirecionamento ou 404 acontece depois do início do streaming. O harness verifica a instrução de redirecionamento/negação e ausência de dados, além do destino real no navegador, sem considerar HTTP 200 isoladamente como acesso permitido.

Dados das capturas são da stack local de verificação. O harness recusa outro banco e remove somente os registros criados na execução. Não lê nem altera o banco de produção.

## Publicação e reversão

1. Obter autorização explícita para publicar no SempreCRM.
2. Conferir novamente a revisão e limpeza do servidor e da principal. Se houver mudanças, integrar e verificar antes de prosseguir.
3. Publicar a revisão preparada usando o fluxo existente do projeto para o servidor `/var/www/semprecrm`, sem alterar configurações pessoais ou credenciais.
4. Conferir disponibilidade do site, login, segundo login e navegação administrativa após a atualização.
5. Em falha de aplicação, retornar ao código `9ea7eabcb0a818b84463a3e03a872849263fded0` e recompilar/recarregar pelo fluxo existente. Esta entrega não contém migração de banco, portanto não exige reversão de dados.

Nenhum push, implantação, alteração de `.env`, nova dependência ou migração foi realizado nesta preparação.

## Observações herdadas da base

O audit de dependências de produção aponta oito alertas (sete altos e um crítico), já existentes na principal; os manifestos e o lockfile estão inalterados. A revisão identificou cadeias de ferramentas de desenvolvimento/build (`shadcn`, Express/MCP, glob e mapas de CSS), sem nova exposição dessas ferramentas pelo painel. A atualização de dependências deve ser tratada separadamente, sem aplicar correções forçadas que mudem versões maiores.

A preferência de idioma salva antes do primeiro carregamento continua seguindo o provider global existente. Esta entrega corrige a corrida comprovada dos rótulos de Leads; não substitui o sistema global de tradução.

Recursos usados: Superpowers, Impeccable, orientações React/Vercel, shipping-and-launch, worktree gerenciado, agent-browser e revisão independente de código/segurança.
