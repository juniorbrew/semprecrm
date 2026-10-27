# Spec: Instagram Direct e Facebook Messenger no inbox

Status: rascunho para aprovação (2026-10-27). Item 3 do roteiro pós-cobrança; Entrega 8 do `docs/verification/vocero-evolution/ROADMAP.md`.

## Objetivo

Hoje o SempreCRM atende só WhatsApp (oficial e QR). O dono de um salão, clínica ou loja recebe muita mensagem pelo Instagram e pela página do Facebook e precisa responder em outro aplicativo. Queremos que essas mensagens caiam no mesmo inbox, com a mesma equipe, filas, etiquetas e (na parte C) a mesma IA.

Sucesso = uma conta conecta o Instagram profissional e/ou a Página do Facebook com um botão, as mensagens chegam no inbox em segundos com nome e foto do cliente, e o atendente responde (texto e mídia) dali mesmo, sem nunca enviar por engano pelo WhatsApp.

## Mapa de partes

| Parte | O que entrega | Depende de |
|---|---|---|
| `omni-base` (A) | Banco (100), contatos sem telefone, webhook único da Meta, mensagens chegando no inbox, resposta manual (texto + mídia), etiqueta do canal e filtro no inbox, trava para nenhum envio automático cair no WhatsApp por engano | — |
| `omni-connect` (B) | Tela de conexão com botão (login da Meta), escolha da Página, assinatura do webhook, renovação do token, desconectar, módulos do plano e limite de canais | A |
| `omni-auto` (C) | IA, automações, fluxos, mensagens agendadas, CSAT e relatórios nos canais novos | A |

Ordem: A → B → C. Um PR por parte. A é testada com mensagens simuladas e uma conexão criada por script no banco local; B só funciona de verdade quando o app da Meta existir (o usuário cria depois e cola as chaves no servidor).

## Decisões (assumidas — corrigir agora se algo estiver errado)

1. **Instagram pela "API do Instagram com login do Instagram"** (`graph.instagram.com`): não exige Página do Facebook ligada. **Messenger pela Página** (`graph.facebook.com/{page-id}/messages`, token da Página). Os dois mandam o mesmo formato de webhook (`entry[].messaging[]`), então há **um só endereço de webhook**: `POST /api/meta/messaging/webhook`.
2. **Conectar = botão de login da Meta (parte B), não colar chave.** As chaves do app ficam só no servidor: `META_APP_ID`/`META_APP_SECRET` (já existem), `INSTAGRAM_APP_ID`/`INSTAGRAM_APP_SECRET`, `META_MESSAGING_VERIFY_TOKEN`. A assinatura `X-Hub-Signature-256` é conferida com o segredo do app certo (o Instagram com login próprio usa o segredo do app do Instagram).
3. **Contato sem telefone.** `contacts.phone` deixa de ser obrigatório; entram `instagram_id` (IGSID) e `messenger_id` (PSID), únicos por conta. Regra no banco: todo contato tem pelo menos um dos três. Não juntamos sozinhos o contato do Instagram com o do WhatsApp (não há dado confiável que ligue os dois); juntar manualmente fica para depois.
4. **Canal na conversa e na mensagem:** `channel` passa a aceitar `'instagram'` e `'messenger'` além de `'official'`/`'qr'` (checks, RPCs do inbox 079 e relatórios 075, `ai_agents.channels`).
5. **Uma conexão de cada por conta** (tabela `meta_messaging_channels`: `account_id`, `kind`, `external_id`, nome, foto, token cifrado com `encryption.ts`, validade do token, status). Token nunca legível pelo navegador (mesma regra da 076).
6. **Janela de 24 h.** Só respondemos até 24 h depois da última mensagem do cliente; não existem modelos (templates) nesses canais. A etiqueta "atendente humano" (7 dias) exige revisão do app pela Meta — fica fora até o app ser aprovado.
7. **Mídia recebida é copiada para o nosso armazenamento** (`chat-media`) na chegada, porque os links da Meta expiram. Mídia enviada usa o link público que já usamos no WhatsApp oficial.
8. **Mensagens enviadas pelo próprio app do Instagram/Facebook** (eco) aparecem no inbox como enviadas pela empresa, como já fazemos com o celular no WhatsApp.
9. **Fora do escopo:** campanhas/disparos em massa (proibido fora da janela), comentários em posts, menções em stories (aparecem como texto "mencionou você no story" com o link), botões/listas interativos.

## Onde mexe (parte A)

- `supabase/migrations/100_meta_messaging_channels.sql` + `supabase/rollback/100_rollback.sql` + teste SQL em `supabase/tests/`.
- `src/types/index.ts` (`WhatsAppChannel` → canais novos; `Contact.phone` opcional — o `tsc` aponta cada uso).
- `src/lib/meta-messaging/` (novo): parse do webhook, envio Instagram/Messenger, perfil do remetente, cópia de mídia.
- `src/app/api/meta/messaging/webhook/route.ts` (novo) + liberar o caminho no `src/middleware.ts`.
- `src/lib/whatsapp/inbound.ts`: `ingestInboundMessage` aceita identidade por canal além de telefone.
- `src/app/api/whatsapp/send/route.ts`: ramo para os canais novos (texto + mídia; recusa modelo e janela fechada).
- `src/lib/whatsapp/qr-engine-send.ts` `conversationChannel()` e os envios automáticos: canal desconhecido **não** pode cair no WhatsApp oficial — na parte A eles recusam com motivo claro; a parte C liga de verdade.
- Inbox: etiqueta "Instagram"/"Messenger" na lista e no topo da conversa, filtro de canal com mais de duas opções, aviso de janela de 24 h sem botão de modelo.
- Dicionário pt-BR (`src/lib/i18n-dict/*` + `npm run i18n:split`).

## Comandos

```
npx tsc --noEmit
npm run lint
npx vitest run            # suíte inteira antes do PR
npm run i18n:split        # depois de mexer no dicionário
npx supabase migration up --include-all --local   # nunca db reset
```

## Testes

- vitest ao lado do código: parse do webhook (texto, mídia, eco, story, reação, duplicado), assinatura com cada segredo, conta resolvida pelo `recipient.id`, contato criado sem telefone, envio monta a chamada certa para cada canal, janela fechada recusa, canal desconhecido nunca chama o WhatsApp.
- SQL: checks novos, unicidade por conta, contato sem nenhuma identidade é recusado, isolamento entre contas.
- Ponta a ponta local: conexão criada por script, webhook assinado enviado por `curl`, conversa aparece no inbox no navegador, resposta sai com a chamada da Meta interceptada.

## Limites

- Sempre: token cifrado e fora do alcance do navegador; webhook recusa sem assinatura válida; toda consulta filtrada por conta.
- Perguntar antes: aplicar 100 em produção; criar o app na Meta (é do usuário).
- Nunca: enviar mensagem de Instagram/Messenger pelo WhatsApp; pedir chave no chat; `db reset`.

## Critérios de pronto (parte A)

- Webhook simulado de Instagram e de Messenger cria contato (nome e foto), conversa e mensagem no inbox da conta certa; repetir o mesmo webhook não duplica.
- Atendente responde texto e imagem; a chamada vai para o endereço certo de cada canal com o token da conta.
- Depois de 24 h sem mensagem do cliente, o envio é recusado com aviso claro.
- Nenhum envio automático (IA, automação, fluxo, agendada, lembrete) sai pelo WhatsApp numa conversa do Instagram/Messenger.
- `tsc`, lint e suíte inteira verdes; 100 e o rollback testados no banco local.

## Perguntas em aberto

- Nenhuma que bloqueie a parte A. Antes da parte B: o usuário confirma se já tem conta de desenvolvedor na Meta (o passo a passo do app vai junto do PR B).
