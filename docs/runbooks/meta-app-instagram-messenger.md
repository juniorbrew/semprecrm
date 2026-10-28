# Criar o app da Meta para Instagram e Messenger

Este passo a passo é para quem administra o SempreCRM (a plataforma), uma vez só. Depois disso, cada cliente conecta o próprio Instagram ou a própria Página do Facebook pelo botão **Conectar**, em Configurações → WhatsApp → "Instagram e Messenger". O cliente nunca cola chave nenhuma.

Os dois canais usam **um só endereço de recebimento** (webhook) e **dois caminhos de login**, porque a Meta separa os dois produtos:

| | Instagram Direct | Facebook Messenger |
|---|---|---|
| Produto no app da Meta | Instagram API with Instagram Login | Messenger |
| Login do cliente | Entra com o Instagram profissional | Entra com o Facebook e escolhe a Página |
| Chave do app (no servidor) | `INSTAGRAM_APP_ID` e `INSTAGRAM_APP_SECRET` | `META_APP_ID` e `META_APP_SECRET` |

> Dica: a tela do desenvolvedor muda de nome de vez em quando. Se um botão não estiver onde está escrito aqui, procure pelo nome do produto no menu da esquerda do app.

## 1. Criar o app

1. Entre em <https://developers.facebook.com> com a conta do dono da plataforma (precisa ser uma conta de desenvolvedor verificada).
2. **Meus apps → Criar app**. Tipo: **Empresa** (Business). Nome: "SempreCRM". Guarde o **ID do app** e a **Chave secreta do app** (Configurações do app → Básico).
3. Em Configurações do app → Básico, preencha: ícone, **URL da Política de Privacidade** e **URL dos Termos** (use as páginas públicas do SempreCRM), categoria e e-mail de contato. Sem isso a Meta não deixa publicar.

## 2. Adicionar os produtos

No painel do app, em **Adicionar produto**, adicione os três:

1. **Messenger** (configurar).
2. **Instagram** → escolha **API do Instagram com login do Instagram** ("Instagram API with Instagram login").
3. **Webhooks**.

Depois de adicionar o produto Instagram, a tela mostra um **ID do app do Instagram** e uma **chave secreta do app do Instagram**. Eles são diferentes do ID e da chave do app principal. Anote os dois.

## 3. Endereços de retorno do login (redirect URIs)

São os endereços para onde a Meta devolve o cliente depois do login. Têm que estar escritos exatamente assim:

- **Instagram**: em Instagram → API com login do Instagram → "Configurar o login de empresa" → **URIs de redirecionamento OAuth válidos**:
  `https://www.semprecrm.com.br/api/meta/messaging/callback/instagram`
- **Messenger (Facebook Login)**: em Produtos → Login do Facebook para Empresas (ou Login do Facebook) → Configurações → **URIs de redirecionamento OAuth válidos**:
  `https://www.semprecrm.com.br/api/meta/messaging/callback/messenger`

Para testar na sua máquina, acrescente também o endereço local equivalente, por exemplo `http://localhost:3101/api/meta/messaging/callback/instagram`. O SempreCRM usa o mesmo endereço da página em que você está quando é `localhost`.

## 4. Webhook (recebimento das mensagens)

Endereço do webhook, o mesmo para os dois canais:

`https://www.semprecrm.com.br/api/meta/messaging/webhook`

**Token de verificação**: invente uma frase longa e aleatória (ex.: gere com `openssl rand -hex 24`). É o valor de `META_MESSAGING_VERIFY_TOKEN` e você digita o mesmo na Meta.

Configure em **Webhooks**:

- **Instagram**: Produto "Instagram" → Webhooks → informe o endereço e o token → **Verificar e salvar**. Assine o campo **messages**. (No Instagram, esse campo já traz também as mensagens que a própria conta envia.)
- **Página (Messenger)**: Produto "Webhooks" → objeto **Page** (ou Messenger → Configurações → Webhooks) → informe o endereço e o token → **Verificar e salvar** → assine **messages** e **message_echoes**.

Importante: só salve o endereço depois que a nova versão do SempreCRM estiver no ar e as variáveis abaixo estiverem no servidor, porque a Meta chama o endereço na hora para conferir.

Quando o cliente clica em **Conectar**, o SempreCRM assina sozinho a conta ou a Página dele nesses campos. Você não precisa fazer isso à mão para cada cliente.

## 5. Variáveis no servidor

No arquivo `/var/www/semprecrm/.env.production` (só os nomes aqui; os valores você copia da Meta e nunca coloca em chat, e-mail ou no código):

```
META_APP_ID=
META_APP_SECRET=
INSTAGRAM_APP_ID=
INSTAGRAM_APP_SECRET=
META_MESSAGING_VERIFY_TOKEN=
```

- `META_APP_ID` / `META_APP_SECRET`: o app principal (Messenger). O `META_APP_SECRET` já é usado pelo WhatsApp oficial; não troque se já existe.
- `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET`: do produto Instagram (passo 2). A Meta assina os avisos do Instagram com essa chave.
- `META_MESSAGING_VERIFY_TOKEN`: a frase do passo 4.
- `NEXT_PUBLIC_SITE_URL` precisa ser `https://www.semprecrm.com.br` (é dele que sai o endereço de retorno do login).

Depois de salvar, reinicie o app (`pm2 restart semprecrm --update-env`) e confira em Configurações → WhatsApp: os botões **Conectar** aparecem. Enquanto uma chave faltar, o cartão mostra "Ainda não configurado pela plataforma".

O renovador das chaves do Instagram roda sozinho no `semprecrm-cron` (a cada 6 horas). Nada a configurar.

## 6. Permissões que a Meta exige na Análise do app (App Review)

Peça só estas. Para cada uma a Meta pede um vídeo curto mostrando o uso:

| Permissão | Produto | Para que o SempreCRM usa |
|---|---|---|
| `instagram_business_basic` | Instagram | Saber qual conta o cliente conectou (nome, foto, identificação) e renovar a chave. |
| `instagram_business_manage_messages` | Instagram | Receber e responder as mensagens do Direct no inbox. |
| `pages_show_list` | Messenger | Listar as Páginas do cliente para ele escolher qual conectar. |
| `pages_messaging` | Messenger | Receber e responder as mensagens da Página no inbox. |
| `pages_manage_metadata` | Messenger | Assinar o recebimento de mensagens da Página (webhook). |

Se a Página do cliente estiver dentro de um Gerenciador de Negócios, a Meta pode pedir também `business_management`. O SempreCRM não pede essa permissão por padrão; só inclua se a conexão acusar que a Página não aparece.

Para a análise, tenha pronto: vídeo do fluxo (Conectar → mensagem chega no inbox → resposta sai), a política de privacidade e uma conta de teste. Só depois de aprovado e com o app em modo **Ativo** (Live) clientes de fora conseguem conectar.

## 7. Testar antes da análise (modo de desenvolvimento)

Com o app em modo **Desenvolvimento**, só quem tem função no app consegue conectar. Dá para testar tudo com a sua própria conta:

1. Em Funções do app, adicione sua conta de desenvolvedor (você já é administrador).
2. **Instagram**: a conta precisa ser **profissional** (Comercial ou Criador de conteúdo). Em Instagram → API com login do Instagram → "Adicionar conta do Instagram", adicione a sua e aceite o convite no próprio Instagram (Configurações → Conta → Permissões do app/Funções). Se o Instagram estiver ligado a uma Página, tudo bem; não é obrigatório.
3. **Messenger**: use uma Página da qual você é administrador.
4. No SempreCRM (conta de teste com plano que inclua os canais, como o trial), vá em Configurações → WhatsApp → "Instagram e Messenger" → **Conectar**.
5. De outro Instagram/Facebook (de preferência uma pessoa que também tenha função no app, pois em modo Desenvolvimento a Meta só entrega mensagens de quem tem função), mande uma mensagem para a conta. Ela deve aparecer no inbox em segundos, com nome e foto.
6. Responda pelo inbox. Passadas 24 horas sem mensagem do cliente, o envio é recusado com aviso (regra da Meta).

Se algo não funcionar: confira primeiro as cinco variáveis, depois se o webhook aparece como "Verificado" na Meta, depois os logs (`pm2 logs semprecrm --lines 100`, procure por `[meta-messaging]` e `[meta-connect]`).

## Referências oficiais usadas

- Login do Instagram: <https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login>
- Webhooks do Instagram: <https://developers.facebook.com/documentation/instagram-platform/webhooks/setup>
- Formato dos avisos do Instagram: <https://developers.facebook.com/documentation/instagram-platform/webhooks/examples>
- Perfil `/me` do Instagram (`user_id` x `id`): <https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/get-started>
- Login do Facebook, fluxo manual: <https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow>
- Chaves de longa duração e chaves de Página: <https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived>
- Webhooks do Messenger: <https://developers.facebook.com/docs/messenger-platform/webhooks>
