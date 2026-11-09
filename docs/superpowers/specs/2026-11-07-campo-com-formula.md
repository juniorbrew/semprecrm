# Spec: campos do negócio e campo com fórmula

Status: rascunho para aprovação (2026-11-07). Item 4.6 do roteiro (ideias do Pipedrive, feitas do nosso jeito: código, textos e marca próprios).

## Objetivo

O gestor quer ver no negócio números que hoje calcula de cabeça ou numa planilha: comissão, margem, frete, valor com imposto. Hoje o negócio não tem campos personalizados. Os campos personalizados que existem são de texto e ficam só no contato.

Sucesso:

- o admin cria campos de número no negócio (por exemplo "Custo", "Frete", "% comissão");
- o admin cria campos com fórmula que fazem contas com esses campos e com os números do negócio (por exemplo "Margem = valor − custo − frete");
- o vendedor preenche os números no negócio, e o resultado da fórmula aparece sozinho na gaveta;
- o resultado também aparece no cartão do Funil, quando o admin marcar essa opção.

## Decisões (escolhas do dono do produto em 2026-11-07)

1. **Onde:** no negócio. Os campos de texto do contato continuam como estão.
2. **Ingredientes da fórmula:**
   - os números do negócio: valor, chance da etapa, soma dos itens e dias até fechar;
   - os campos de número que o admin criar no negócio.
3. **Onde aparece:**
   - sempre na gaveta do negócio;
   - no cartão do Funil, para os campos que o admin marcar com "mostrar no cartão".

## Tipos de campo

| Tipo | O vendedor digita | Mostra como |
|---|---|---|
| Número | 12,5 | 12,5 |
| Dinheiro | 150,00 | R$ 150,00 (na moeda do negócio) |
| Porcentagem | 5 | 5% |
| Fórmula | nada (é calculada) | número, dinheiro ou porcentagem, conforme o admin escolher |

## A fórmula

- **Contas:** `+  −  ×  ÷` e parênteses. Também aceita `*`, `/` e `-` digitados no teclado.
- **Números:** fixos, com vírgula ou ponto (`0,05`, `1.5`).
- **Campos:** entram pelo nome entre chaves, por exemplo `{Custo}` e `{% comissão}`. O editor tem uma lista para clicar e inserir o campo, então ninguém precisa digitar o nome certo.
- **Números do negócio:**
  - `{Valor}`: o valor do negócio.
  - `{Chance}`: a chance da etapa (definida ou automática, igual à 4.4).
  - `{Itens}`: a soma dos produtos e serviços.
  - `{Dias para fechar}`: dias até a data prevista; negativo se já passou.
- **Porcentagem vira fração na conta.** "% comissão" igual a 5 entra como 0,05, e a chance de 60% entra como 0,6. Assim, `{Valor} × {% comissão}` dá a comissão certa.
- **Sem valor:**
  - Se um campo usado na fórmula está vazio, o resultado mostra "—" com a dica "preencha Custo".
  - Divisão por zero também mostra "—".
- **Uma fórmula não usa outra fórmula** nesta versão. Isso evita contas em círculo. Fica para depois, se fizer falta.
- **Validação ao salvar:**
  - o editor recusa a fórmula com erro (parêntese aberto, campo que não existe, conta pela metade);
  - mostra uma prévia com números de exemplo;
  - aceita até 300 caracteres.
- **Sem `eval`:** a fórmula é lida por um leitor próprio, pequeno, que só entende números, campos, as quatro contas e parênteses.
- **Onde a conta acontece:** no navegador, na hora de mostrar. O resultado não é guardado no banco, então mudar a fórmula vale na hora para todos os negócios.

## Onde fica cada coisa

- **Configurações → Campos personalizados:**
  - ganha duas abas: "Contato" (a tela de hoje) e "Negócio" (nova);
  - na aba Negócio: criar, renomear, reordenar e excluir campos, escolher o tipo, editar a fórmula e marcar "mostrar no cartão";
  - só o admin mexe.
- **Gaveta do negócio:**
  - nova seção "Campos", com todos os campos na ordem do admin;
  - os campos de número podem ser editados ali mesmo (clica, digita, Enter) por quem já edita negócios (agente ou mais);
  - as fórmulas aparecem só para ler.
- **Editar negócio (formulário):** também mostra os campos de número para preencher.
- **Cartão do Funil:** até 2 campos marcados com "mostrar no cartão", em uma linha pequena, por exemplo "Margem R$ 320".

## Banco (migration `107_deal_fields.sql`)

- **`deal_fields`:**
  - colunas: `id`, `account_id`, `name`, `kind` (number, currency, percent ou formula), `expression` (só na fórmula, até 300 caracteres), `result_format` (só na fórmula: number, currency ou percent), `show_on_card` (bool), `position`, `created_by`, `created_at` e `updated_at`;
  - CHECKs: a fórmula exige `expression` e `result_format`, e os outros tipos não podem ter nenhum dos dois;
  - nome único por conta, sem diferenciar maiúscula de minúscula;
  - limite de 50 campos por conta.
- **`deal_field_values`:**
  - colunas: `deal_id`, `field_id`, `account_id` e `value` numeric, com chave `(deal_id, field_id)`;
  - um gatilho preenche `account_id` a partir do negócio e recusa campo de outra conta ou campo do tipo fórmula (mesmo padrão do `deal_items_guard` da 104);
  - `value` com limite de tamanho (CHECK).
- **Quem pode o quê:**
  - membro da conta lê;
  - `deal_fields` só o admin escreve;
  - `deal_field_values` qualquer um a partir de agente escreve, igual à `deal_items`.
- **Padrões já usados:**
  - GRANT/REVOKE no padrão 076/104;
  - bloqueio de cobrança (somente leitura) nas duas tabelas, padrão 094;
  - rollback e teste SQL.
- **Excluir:**
  - excluir um campo apaga os valores dele (CASCADE), com confirmação no app;
  - se o campo excluído é usado por alguma fórmula, o app avisa antes quais fórmulas vão parar de funcionar;
  - essas fórmulas passam a mostrar "campo excluído" até serem editadas.

## Módulo e textos

- **Módulo:** `pipelines`. Sem esse módulo, nada disso aparece.
- **i18n:**
  - frases com mais de uma palavra, `data-no-translate` nos nomes dos campos e nos valores, e `npm run i18n:split`;
  - os nomes de variável (`{Valor}`, `{Chance}`, `{Itens}`, `{Dias para fechar}`) são fixos em português. Na fórmula, o sistema os guarda como código interno, então trocar o idioma não quebra a conta.

## Fora do escopo

- Fórmula que usa outra fórmula.
- Funções (SE, MÁXIMO, ARREDONDAR).
- Campos de texto, data ou lista no negócio.
- Filtrar ou ordenar o Funil por campo.
- Exportar.
- Usar os campos em relatórios, automações ou na previsão.
- Campos com fórmula no contato.

## Testes

- **Leitor de fórmula (Vitest):**
  - prioridade das contas e parênteses;
  - vírgula decimal;
  - menos unário;
  - campo vazio, divisão por zero e campo inexistente;
  - porcentagem como fração;
  - texto malicioso (letras soltas, `constructor`, `__proto__`, fórmula gigante, 1.000 parênteses) recusado sem travar.
- **Tela de configuração:** criar cada tipo, validação da fórmula com prévia, aviso ao excluir campo usado, só admin.
- **Gaveta:** editar o valor na hora, "—" com dica, a fórmula recalcula depois de salvar.
- **Cartão:** no máximo 2 campos, formato certo.
- **SQL (banco local):**
  - membro de outra conta não lê nem escreve;
  - anon sem acesso;
  - agente não cria campo;
  - valor em campo de fórmula é recusado;
  - campo de outra conta é recusado;
  - CHECKs, limite de 50 campos e nome repetido;
  - CASCADE;
  - conta somente leitura bloqueada.
- **Portões:** tsc, lint (base de 14 avisos), i18n:split, vitest completo, teste SQL, revisão de código e revisão de segurança (Opus) e conferência no navegador (computador e iPhone).
