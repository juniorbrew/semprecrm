# Teste dos extras no ambiente de testes do Asaas (sandbox)

Objetivo: confirmar, com o Asaas de verdade (ambiente de testes, sem dinheiro real), como ele se comporta
nas situações em que o código dos extras (PR #145) depende dele. Só depois disso colocar preço de extra
em Plataforma → Planos na produção.

Tudo roda **no computador local** (pasta `C:\SempreCRM-indicadores`, banco local), nunca na VPS.

## Quem faz o quê

| Passo | Quem |
|---|---|
| Criar a conta de testes no Asaas e gerar a chave | **Dono** |
| Colocar a chave no `.env.local` da pasta de teste | **Dono** (a chave nunca passa pelo chat) |
| Ligar o sistema local, rodar os cenários, conferir banco e Asaas, anotar o resultado | Claude |
| Ações que só existem na tela do Asaas (estornar, por exemplo) | **Dono**, quando o Claude pedir |

## 1. Preparação (dono)

1. Crie uma conta em https://sandbox.asaas.com (é separada da conta real).
2. Em Integrações → Chave de API, gere uma chave de **sandbox** (começa com `$aact_hmlg_`).
3. Abra `C:\SempreCRM-indicadores\.env.local` e acrescente no fim:
   ```
   ASAAS_API_URL=https://api-sandbox.asaas.com/v3
   ASAAS_API_KEY=<a chave de sandbox>
   ASAAS_WEBHOOK_TOKEN=teste-local-extras
   ```
   Se já existirem linhas `ASAAS_*` nesse arquivo, troque por estas. **Nunca** use a chave de produção aqui.
   A chave começa com `$`: escreva `ASAAS_API_KEY=\$aact_hmlg_...` (com a barra antes do `$`). Sem a barra o
   Next lê a chave vazia. O mesmo vale para a chave de produção na VPS.
4. Docker Desktop ligado. Avise o Claude: "sandbox pronto".

Observação: o Asaas não consegue mandar avisos (webhook) para o computador local. O Claude simula o aviso
chamando o sistema local com o token acima; o sistema sempre confere o pagamento direto no Asaas antes de
fazer qualquer coisa, então o teste vale.

## 2. Montagem (Claude)

- Sistema local na porta 3115, conta demo (`demo@semprecrm.local`).
- Plano Pro com preço de extra no banco local: usuário R$ 19,90, número R$ 49,90.
- A cada passo: confere `account_billing`, a assinatura e as cobranças no sandbox, e roda a tarefa de
  hora em hora (`/api/billing/cron`) na mão em vez de esperar.

## 3. Cenários

Cada cenário diz o que fazer e o que **deve** acontecer. Se acontecer outra coisa, o Claude anota e
corrige antes de liberar os extras.

### A. Plano mensal

1. **Assinar o Pro mensal** pela tela Plano e marcar a 1ª cobrança como paga no sandbox
   ("confirmar recebimento em dinheiro").
   - Deve: conta ativa; o Asaas gera a próxima cobrança (anotar **quando** ele gera: na hora ou só perto do vencimento).
2. **Comprar 1 usuário extra**.
   - Deve: limite sobe na hora; o valor da assinatura no Asaas sobe R$ 19,90.
   - **Pergunta principal:** a próxima cobrança, se já estava gerada, também subiu? (`updatePendingPayments`)
3. **Repetir o passo 2 com uma cobrança vencida** (data de vencimento passada no sandbox).
   - Deve: o sistema recusa a compra ("cobrança atrasada"). Anotar se o Asaas muda o valor de cobrança vencida.
4. **Remover o extra**.
   - Deve: limite para novos usuários cai na hora; o valor no Asaas só baixa depois que a cobrança cheia do
     período é paga; o extra some no dia certo.
5. **Lista de cobranças:** com mais de 10 cobranças na assinatura (o Claude cria pelo sandbox), conferir
   que o sistema lê todas e acha a próxima certa, em qualquer ordem que o Asaas devolver.

### B. Plano anual

6. **Assinar o Pro anual** e pagar a 1ª cobrança.
7. **Comprar 2 usuários extras**.
   - Deve: sai uma **cobrança avulsa** no Asaas (sem assinatura), valor = meses até a renovação × 2 × R$ 19,90 × 10/12;
     o limite **não** sobe ainda; a tela mostra "Aguardando pagamento" e o link.
8. **Pagar a avulsa** no sandbox e simular o aviso.
   - Deve: limite sobe; valor da renovação no Asaas sobe.
9. **Comprar de novo e não pagar**; avançar o prazo (o Claude ajusta a data no banco local) e rodar a tarefa.
   - Deve: a avulsa é **apagada** no Asaas; nada muda na conta. Anotar o que o Asaas devolve ao consultar
     uma cobrança apagada (`deleted: true`? erro 404?).
10. **Estorno da avulsa paga** (dono estorna na tela do sandbox, se o sandbox permitir estornar pagamento
    em dinheiro; senão, pagar com o cartão de teste do Asaas e estornar).
    - Deve: a conta passa para "pagamento pendente".

## 4. Resultado

O Claude escreve no fim deste arquivo, para cada passo: **ok** ou **diferente** (o que o Asaas fez de fato).
Qualquer "diferente" vira correção antes de colocar preço de extra na produção.

Depois do teste: o dono apaga as 3 linhas `ASAAS_*` do `.env.local` (ou deixa, é só sandbox), e o Claude
desfaz os dados de teste do banco local.

## Resultado do teste

Rodado em 26/11/2026 no sandbox, com o sistema local (main 4a094a4 + a correção abaixo). Os avisos de
pagamento foram simulados (o Asaas não alcança o computador local); o sistema conferiu cada um no Asaas.

| Passo | Resultado |
|---|---|
| 1. Assinar Pro mensal e pagar | **ok**: conta ativa. O Asaas **não** gera a próxima cobrança na hora: só perto do vencimento (`nextDueDate` 26/12, nenhuma cobrança gerada no dia). |
| 2. Comprar 1 usuário (mensal) | **ok**: limite subiu na hora; valor da assinatura 89,90 → 109,80. |
| 2b. `updatePendingPayments` com cobrança já gerada | **ok**: cobrança PENDING de 10,00 virou 15,00 (assinatura de teste à parte). |
| 3. Cobrança vencida | **pendente**: o Asaas não aceita criar cobrança com vencimento no passado; a cobrança de teste (`sub_5ilpadp58mjwoe3u`, vence 26/11) fica vencida no dia seguinte, e aí se confere se o valor de uma cobrança vencida muda. |
| 4. Remover o extra (mensal) | **diferente → corrigido**: a remoção ficou para 26/01 (certo), mas a tarefa de hora em hora baixou o valor no Asaas **na hora**, porque a última cobrança existente antes do dia era a de 26/11 (paga) e a de 26/12 ainda não tinha sido gerada. A de 26/12 sairia sem o extra (um mês de graça). Correção: só baixa quando a cobrança paga é a do último período (vence um ciclo antes do dia). Teste novo em `extras-sweep.test.ts`; rodado de novo no sandbox: não baixou mais. |
| 5. Mais de 10 cobranças | **em parte**: a resposta do Asaas traz `hasMore`/`totalCount`, que o sistema usa para paginar. Não dá para gerar 10+ cobranças de verdade numa assinatura de teste sem esperar os ciclos. |
| 6. Assinar Pro anual e pagar | **ok**: R$ 899,00/ano (10 × mensal). |
| 7. Comprar 2 usuários (anual) | **ok**: cobrança avulsa sem assinatura de R$ 398,00 (12 meses × 2 × 19,90 × 10/12), vence em 3 dias; limite não subiu antes de pagar. |
| 8. Pagar a avulsa | **ok**: 2 extras liberados; renovação 899,00 → 1.297,00; `extras_first_due` = renovação. |
| 9. Avulsa não paga em 7 dias | **ok**: a tarefa apagou a cobrança; conta sem mudança. Consultar uma cobrança apagada devolve **200 com `deleted: true` e status PENDING** (não 404); apagar de novo também devolve 200. |
| 10. Estorno da avulsa paga | **ok**: dinheiro não pode ser estornado (o Asaas só estorna cartão e Pix); paga com o cartão de teste do Asaas e estornada: a conta passou para `past_due`. |
