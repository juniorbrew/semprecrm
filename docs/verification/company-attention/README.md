# Alertas de situação das empresas

A Visão geral inclui empresas suspensas e com pagamento em atraso em “Precisam de atenção”, mesmo quando não há alerta de vencimento ou capacidade. Cada empresa continua sendo contada uma única vez, mostra os motivos em texto e mantém o acesso direto ao seu detalhe. Alertas e filtros existentes são preservados. Sem alteração de banco, permissões ou dependências.

## Verificação em 08/10/2026

- Testes de alertas e filtros: 14 passaram. Cobrem os dois estados, contagem sem duplicação e empresas sem alerta.
- ESLint dos arquivos TypeScript modificados, TypeScript, formatação, sintaxe do roteiro e `git diff --check`: passaram.
- Compilação com o ambiente local isolado: passou. Permanecem os avisos existentes de middleware/Edge Runtime.
- Revisão independente do código e dos ajustes no roteiro: nenhum defeito acionável.
- [Rodada final no navegador](results.json): 18 grupos passaram às 21:21 (Bahia), incluindo motivos de suspensão/atraso, acesso ao detalhe, permissões, filtros, celular a 375×812 e temas claro/escuro. Zero erros de navegador, requisições sem falhas e zero violações de acessibilidade. Limpeza dos cadastros fictícios concluída.
- Suíte completa anterior: 3.733 testes passaram, um foi ignorado e um teste da busca rápida excedeu o limite de tempo. Os oito testes desse arquivo passaram na repetição isolada final. Não foi alterado o código ou o limite de tempo da busca rápida; não houve nova rodada da suíte completa após essa repetição.

O roteiro foi corrigido para definir explicitamente a largura de celular antes da captura e auditoria da Visão geral. Evidências anteriores à correção não são utilizadas como comprovação de celular. Interrupções do Docker ocorreram em tentativas anteriores; os oito cadastros fictícios remanescentes foram identificados por horário, nomes e contas de teste e removidos exclusivamente no ambiente isolado.

## Capturas

- [Motivos dos novos alertas](status-alerts.png)
- [Celular](mobile.png)
- [Computador, tema escuro](desktop.png)
- [Computador, tema claro](desktop-light.png)
- [Auditoria no celular, tema escuro](a11y.json)
- [Auditoria no computador, tema claro](a11y-light.json)

Recursos usados: Superpowers para implementação/verificação, Ponytail para escopo mínimo, Impeccable/frontend para preservar a interface e agent-browser para validação real. Revisão independente por `catalog_review_completion`.

Estado: validado localmente; publicação ainda não autorizada para esta alteração.
