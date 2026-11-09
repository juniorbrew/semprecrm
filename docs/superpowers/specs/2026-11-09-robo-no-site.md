# Spec: robô de conversa no site que cria lead

Status: rascunho para aprovação (2026-11-09). Item 4.7 do roteiro (ideias do Pipedrive, feitas do nosso jeito: código, textos e marca próprios).

## Objetivo

A empresa cliente do SempreCRM quer captar quem visita o site dela. Hoje isso só funciona com um formulário ligado ao webhook de "Fontes de leads" (migration 029), e o formulário precisa ser montado pela própria empresa.

Com o robô, a empresa cola uma linha de código no site. Aparece um balão de conversa no canto da tela. O robô cumprimenta o visitante, faz as perguntas que o admin escreveu e, no fim, cria o contato e o negócio no Funil. Depois mostra o botão "Continuar no WhatsApp".

Sucesso:
- o admin monta o robô sem programar e copia o código pronto;
- o visitante conversa pelo celular ou pelo computador;
- o lead aparece no Funil com as respostas;
- a conversa continua no WhatsApp da empresa.

## Decisões (escolhas do dono do produto em 2026-11-09)

1. **Perguntas prontas, sem IA.** O admin escreve a saudação e as perguntas, e o robô as faz uma por vez. Não tem custo de IA e funciona em todos os planos que têm o módulo de captura de leads (`lead_capture`).
2. **No fim:**
   - cria o lead pelo mesmo caminho dos formulários (`ingestLead`): contato sem duplicar, negócio no funil e etapa escolhidos, etiquetas, responsável, automações e o registro em "Eventos";
   - mostra "Continuar no WhatsApp", que abre o WhatsApp da empresa com uma mensagem pronta ("Olá! Sou Ana, vim pelo site.").
3. **A conversa não continua no site.** Um canal "Site" no Caixa de entrada fica fora desta entrega.

## Como funciona para o admin

Fica em **Configurações → Integrações → Fontes de leads**. O botão novo **"Novo robô do site"** cria uma fonte do tipo robô. As fontes por webhook continuam iguais.

O editor do robô tem:
- **Aparência:**
  - nome do robô (ex.: "Assistente da Loja");
  - cor principal;
  - texto do balão (ex.: "Posso ajudar?");
  - lado da tela (direita ou esquerda).
- **Saudação:** a primeira mensagem do robô.
- **Perguntas:** em ordem, com setas para reordenar, até 10 perguntas. Cada uma tem:
  - **texto da pergunta;**
  - **tipo de resposta:** texto livre, lista de botões (até 6 opções), nome, WhatsApp/telefone ou e-mail;
  - **onde a resposta é guardada:** nome do contato, telefone, e-mail, um campo personalizado do contato, ou só na nota do negócio;
  - **obrigatória ou opcional.**
  - **Nome e WhatsApp são sempre obrigatórios.** Sem telefone não há lead, como já acontece nos formulários.
- **Destino do lead:** funil, etapa, etiquetas e responsável, iguais aos das fontes por webhook.
- **Fim da conversa:**
  - mensagem de agradecimento;
  - liga ou desliga o botão do WhatsApp;
  - número do WhatsApp: escolhe um dos números conectados da conta ou digita outro;
  - texto da mensagem pronta, com `{nome}`.
- **Privacidade (LGPD):**
  - texto de consentimento curto, com um link opcional para a política de privacidade do site;
  - o visitante precisa marcar a caixa antes de enviar o telefone.
- **Sites permitidos:** lista de domínios onde o robô pode rodar (ex.: `minhaloja.com.br`). Pedidos vindos de outros sites são recusados.
- **Prévia ao vivo:** o robô aparece funcionando dentro da tela de configuração, sem criar lead.
- **Código para colar:**
  - uma linha `<script src="https://www.semprecrm.com.br/robo.js" data-robo="<chave pública>" async></script>`, com botão "Copiar";
  - instruções curtas para WordPress, Wix e sites comuns.
- **Ligar ou desligar** o robô sem apagar.

## Como funciona para o visitante

- Um balão redondo no canto, na cor escolhida, com o texto do balão.
- Ao clicar, abre a janela de conversa: o robô "digita" e manda a saudação, depois uma pergunta por vez.
  - O visitante responde digitando ou tocando nas opções.
  - O telefone é conferido (DDD e número) antes de seguir, e o e-mail também.
- No fim, o visitante vê o agradecimento e o botão "Continuar no WhatsApp".
- **No celular,** a janela ocupa a tela inteira e tem botão de fechar.
- **Acessibilidade:** dá para usar só com o teclado, o leitor de tela anuncia as mensagens novas e as cores têm contraste suficiente.
- **Se o visitante fechar no meio,** as respostas ficam guardadas só no navegador dele por 1 dia. Se ele voltar, continua de onde parou. Nada é enviado antes do fim.

## Técnica

- **Script do robô:** `public/robo.js`, em JavaScript puro, pequeno (meta: menos de 20 KB) e sem bibliotecas.
  - Desenha tudo dentro de uma "shadow DOM", para não brigar com o visual do site da empresa nem ser afetado por ele.
  - Não usa iframe.
  - Textos fixos do robô em português (com a opção de inglês pelo idioma do navegador).
- **Chave pública:** cada robô ganha uma `public_key` própria, diferente do `token` secreto do webhook. Ela aparece no código do site, então só serve para ler a configuração pública e enviar respostas para esse robô.
- **Rotas públicas novas:**
  - `GET /api/v1/robo/[chave]`: devolve só a configuração pública (aparência, saudação, perguntas, texto LGPD). Nunca devolve funil, etiquetas, responsável nem dados internos.
  - `POST /api/v1/robo/[chave]`: recebe as respostas, valida tudo de novo no servidor (tipos, tamanhos, opções que existem, telefone, consentimento), monta o lead e chama `ingestLead` com o destino da fonte.
  - **Tratamento de erro:** robô desligado ou apagado devolve 404. A resposta nunca revela se um contato já existia.
- **Proteções:**
  - **CORS e Origin:** só os domínios cadastrados (e subdomínios www). Sem domínio cadastrado, o robô só roda na prévia.
  - **Limite de envios:** por IP e por robô (ex.: 5 leads a cada 10 minutos por IP e 60 por minuto por robô), no mesmo `checkRateLimit` do webhook.
  - **Anti-robô:**
    - campo escondido "isca": se vier preenchido, o pedido é descartado em silêncio;
    - tempo mínimo de conversa: menos de 3 segundos é descartado.
  - **Tamanhos:** cada resposta até 500 caracteres, o pedido inteiro até 8 KB.
  - **Textos:** os textos do visitante são guardados como texto, nunca como HTML, tanto no robô como no CRM.
  - **LGPD:**
    - grava que houve consentimento, com data e hora, no evento da fonte;
    - respeita a lista de bloqueio (`findSuppressedPhones`), como o webhook já faz.
- **Banco (migration `108_site_bot.sql`):**
  - **Colunas novas em `lead_sources`:**
    - `kind`: webhook ou site_bot, padrão webhook, então as fontes atuais não mudam;
    - `public_key`: única, gerada no servidor;
    - `bot_config`: JSONB com aparência, perguntas, fim, LGPD e domínios, com CHECK de formato e tamanho;
    - para o robô, o `token` secreto continua existindo, mas não é usado.
  - **Leitura pública:** feita pelo servidor (service role) dentro da rota, nunca pelo navegador. As permissões de leitura e escrita da 029 continuam valendo para o admin.
  - Rollback e teste SQL.
- **Configurações:** o editor fica em `src/components/settings/`, ao lado de `lead-sources-settings.tsx`, e reaproveita o seletor de funil, etapa, etiquetas e responsável que já existe.
- **CSP:** a política do app (`frame-ancestors 'none'`) não muda. O `robo.js` é servido com cache curto (1 hora) e precisa de CORS liberado só para ele.
- **i18n:** o editor usa o dicionário, com frases de várias palavras e `npm run i18n:split`. O `robo.js` tem os textos próprios dele, porque roda fora do app.

## Fora do escopo

- IA no robô.
- Conversa que continua no site (canal "Site" no Caixa de entrada).
- Horário de atendimento.
- Perguntas condicionais ("se respondeu X, pergunte Y").
- Vários idiomas configuráveis.
- Upload de arquivos.
- Relatório de conversas abandonadas.

## Testes

- **Vitest:**
  - validação do `bot_config` (limites, tipos, nome e WhatsApp obrigatórios);
  - montagem do lead a partir das respostas (mapeamento para nome, telefone, e-mail, campo personalizado e nota);
  - a rota pública: config sem dados internos, robô desligado (404), Origin fora da lista, sem consentimento, isca, rápido demais, tamanho, limite de envios, telefone inválido, contato repetido sem vazar a informação, lista de bloqueio da LGPD;
  - o link do WhatsApp (número e texto codificados);
  - o editor (criar, ordenar, prévia, copiar o código).
- **Script `robo.js`:** testes com jsdom (abrir, responder, validar telefone, retomar depois de fechar, teclado, `aria-live`).
- **SQL:** colunas novas, CHECKs, `public_key` única, fontes antigas intactas, permissões (agente não cria robô, anon sem acesso).
- **Navegador:**
  - uma página de teste local que carrega o `robo.js` como um site de verdade, no computador e no iPhone;
  - o lead criado aparece no Funil;
  - o botão do WhatsApp abre o link certo.
- **Portões:** tsc, lint (base de 14 avisos), i18n:split, vitest completo, teste SQL, revisão de código e revisão de segurança (Opus). Rota pública nova e dados pessoais, então a revisão de segurança é obrigatória.
