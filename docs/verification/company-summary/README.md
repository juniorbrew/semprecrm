# Resumo administrativo da empresa

Verificado localmente em 7 de outubro de 2026, com dados sintéticos e Supabase isolado.

O detalhe da empresa apresenta responsável, plano, vencimento no horário da Bahia, ocupação de usuários e canais e os alertas calculados pelas mesmas regras da visão geral. Convites pendentes contam no limite de usuários. O resumo representa os dados salvos; alterações do formulário continuam na prévia até salvar.

Também foram corrigidos contrastes dos controles da ficha nos temas claro e escuro. Não há alterações de banco de dados, dependências, autenticação ou ações do formulário.

## Verificação

- 18 testes aprovados em quatro arquivos: resumo, regras da visão geral, proteção do layout e criptografia do segundo acesso.
- ESLint dos arquivos alterados e `git diff --check` aprovados.
- Compilação de produção e checagem de tipos aprovadas.
- Dez verificações reais de navegador aprovadas: `results.json`.
- Resumo verificado em 1440, 768 e 375 pixels, sem rolagem horizontal.
- Auditorias axe da ficha e da visão geral nos dois temas sem violações.
- Nenhum erro de navegador ou requisição malsucedida detectado.
- Revisão independente do código sem pendências.

Capturas principais: `company-summary-1440.png`, `company-summary-375.png` e `company-summary-light.png`. As demais capturas documentam os fluxos existentes exercitados na mesma execução. Os identificadores e e-mails nas capturas pertencem aos dados sintéticos.

Esta evidência comprova a versão local. A publicação desta etapa depende de autorização do usuário.
