# Agenda — integração com Google Agenda e Outlook

A Agenda do SempreCRM (módulo `calendar`) sincroniza nos dois sentidos com o **Google Agenda** e com o
**Outlook / Microsoft 365**. Cada usuário conecta a própria conta em **Configurações → Agenda**; o
administrador do servidor só precisa registrar um aplicativo OAuth em cada provedor e colocar as
credenciais no `.env`. Sem as variáveis, a tela mostra "Integração não configurada" e o resto da agenda
funciona normalmente.

O que é sincronizado: título, descrição, local, início/fim, "dia inteiro" e o status (cancelado). Os
vínculos com contato, conversa, negócio, tarefa e chat, os participantes, a cor e o lembrete ficam só
no CRM. Eventos criados no provedor entram na agenda do usuário conectado (com o ícone do provedor) e
podem ser editados aqui — a edição é reenviada. Exclusão no provedor cancela o compromisso aqui; em
conflito, vence a alteração mais recente.

## Variáveis de ambiente

| Variável | Uso |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | cliente OAuth "Aplicativo da Web" do Google Cloud |
| `MS_CLIENT_ID` / `MS_CLIENT_SECRET` | registro de aplicativo no Microsoft Entra ID |
| `MS_TENANT` | `common` (padrão: contas pessoais e corporativas), `organizations`, `consumers` ou o ID do seu locatário |
| `CALENDAR_SYNC_INTERVAL_MS` | intervalo do cron de sincronização (`scripts/cron-tick.mjs`), padrão 300000 (5 min) |

Os tokens de acesso ficam cifrados no banco com a `ENCRYPTION_KEY` (a mesma dos tokens do WhatsApp).
Trocar a chave obriga todo mundo a reconectar.

### URLs de redirecionamento

Registre exatamente estas URLs no provedor (com o mesmo esquema/host/porta do `NEXT_PUBLIC_SITE_URL`):

```
${NEXT_PUBLIC_SITE_URL}/api/integrations/google/callback
${NEXT_PUBLIC_SITE_URL}/api/integrations/microsoft/callback
```

Exemplo em produção: `https://crm.seudominio.com.br/api/integrations/google/callback`.

> **Google só aceita `localhost` ou um domínio real** como redirecionamento — nunca um IP de rede
> local (`http://192.168.1.10:3101` é recusado com `invalid_request`). Nesta máquina de testes, em que
> `NEXT_PUBLIC_SITE_URL` aponta para o IP da rede, conecte pelo navegador em
> **http://localhost:3101** (ou `http://localhost:3102` no `next dev`): quando a requisição chega por
> `localhost`, o app usa esse endereço como base do redirecionamento, então registre também
> `http://localhost:3101/api/integrations/google/callback` no cliente OAuth. A Microsoft aceita
> `http://localhost` e domínios `https`; também não aceita IP de rede.

## Google Cloud — passo a passo

1. Acesse <https://console.cloud.google.com/> e crie um projeto (ou use um existente). Anote o nome.
2. **APIs e serviços → Biblioteca**: procure **Google Calendar API** e clique em **Ativar**.
3. **APIs e serviços → Tela de permissão OAuth** (Google Auth Platform):
   - Tipo de usuário **Externo** (ou **Interno** se todos os usuários forem do seu Google Workspace).
   - Nome do app (ex.: "SempreCRM"), e-mail de suporte, logotipo opcional, e-mail do desenvolvedor.
   - **Escopos**: adicione `https://www.googleapis.com/auth/calendar.events`,
     `https://www.googleapis.com/auth/calendar.readonly`, `openid` e `.../auth/userinfo.email`.
   - Em modo **Teste**, adicione os e-mails dos usuários que vão conectar (até 100). Para liberar a
     todos, envie o app para verificação (**Publicar app**); até lá o Google mostra um aviso "app não
     verificado" que o usuário pode aceitar em *Avançado → Ir para …*.
4. **APIs e serviços → Credenciais → Criar credenciais → ID do cliente OAuth**:
   - Tipo **Aplicativo da Web**, nome livre.
   - **URIs de redirecionamento autorizados**: `https://SEU-DOMINIO/api/integrations/google/callback`
     (e `http://localhost:3101/api/integrations/google/callback` para testes locais).
   - Salve e copie o **ID do cliente** e a **Chave secreta do cliente**.
5. No `.env` do app:
   ```
   GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-...
   ```
6. Reinicie o app. Em **Configurações → Agenda** o cartão "Google Calendar" passa a mostrar **Conectar**.

O app pede `access_type=offline` e `prompt=consent`, então recebe um *refresh token* a cada conexão e
renova o acesso sozinho. Se o usuário remover o acesso em <https://myaccount.google.com/permissions>,
a conexão fica marcada como "Acesso revogado" e basta reconectar.

## Microsoft Entra (Outlook / Microsoft 365) — passo a passo

1. Acesse <https://entra.microsoft.com/> (ou o portal do Azure) → **Identidade → Aplicativos →
   Registros de aplicativo → Novo registro**.
2. Nome (ex.: "SempreCRM"). **Tipos de conta com suporte**: "Contas em qualquer diretório
   organizacional e contas pessoais da Microsoft" para aceitar Outlook.com e Microsoft 365 (é o que o
   `MS_TENANT=common` espera). Se for só a sua organização, escolha "Somente este diretório" e defina
   `MS_TENANT=<ID do locatário>`.
3. **URI de redirecionamento**: plataforma **Web**,
   `https://SEU-DOMINIO/api/integrations/microsoft/callback` (adicione depois
   `http://localhost:3101/api/integrations/microsoft/callback` para testes, em *Autenticação*).
4. Registre e copie o **ID do aplicativo (cliente)**. Em *Visão geral* também está o **ID do diretório
   (locatário)**, caso use um locatário fixo.
5. **Certificados e segredos → Novo segredo do cliente**: descrição e validade (máx. 24 meses — anote a
   data para renovar). Copie o **Valor** na hora; ele não aparece de novo.
6. **Permissões de API → Adicionar uma permissão → Microsoft Graph → Permissões delegadas**:
   `Calendars.ReadWrite`, `offline_access`, `User.Read`. Não é preciso consentimento do administrador;
   cada usuário consente ao conectar (um administrador pode "Conceder consentimento" para o locatário
   inteiro, se preferir).
7. No `.env` do app:
   ```
   MS_CLIENT_ID=00000000-0000-0000-0000-000000000000
   MS_CLIENT_SECRET=...
   MS_TENANT=common
   ```
8. Reinicie o app. O cartão "Outlook" em **Configurações → Agenda** passa a mostrar **Conectar**.

Quando o segredo vencer, os *refresh tokens* param de funcionar: crie um segredo novo, atualize
`MS_CLIENT_SECRET` e reinicie — as conexões continuam válidas.

## Como funciona a sincronização

- **Cron**: `scripts/cron-tick.mjs` chama `POST /api/integrations/calendar/sync` (header
  `x-cron-secret`) a cada 5 minutos — até 20 conexões por chamada, as mais antigas primeiro. Também
  ao abrir `/agenda` (se a última sincronização tem mais de 2 min) e no botão **Sincronizar agora**.
- **Saída**: compromissos do usuário conectado (dono, ou participante com "Espelhar compromissos em
  que sou participante" ligado e cujo dono não tem agenda conectada) são criados/atualizados no
  provedor; um compromisso cancelado é removido lá; um `sync_hash` evita reenviar sem mudança. Cada
  compromisso vai para uma única agenda externa.
- **Entrada**: leitura incremental (Google `syncToken`, Graph `calendarView/delta`, janela de 30 dias
  para trás). Recorrências chegam como instâncias individuais.
- **Fusos**: tudo é guardado em UTC; "dia inteiro" usa o fuso da conta (Configurações → Atendimento →
  horário comercial).
- **Erros**: 401/`invalid_grant` marcam a conexão como *revogada* (o cartão pede para reconectar);
  outros erros ficam em *erro* com a mensagem no cartão e são tentados de novo no próximo ciclo.
  429 é repetido uma vez respeitando `Retry-After`.
- **Desconectar** revoga o token (Google), apaga os eventos importados daquele provedor e mantém os
  compromissos internos, só desvinculados.

## Testando sem credenciais reais

Com as variáveis vazias, a tela mostra "Integração não configurada". Com qualquer valor (ex.
`GOOGLE_CLIENT_ID=x GOOGLE_CLIENT_SECRET=x`), **Conectar** redireciona para a tela de consentimento do
provedor (que vai recusar o cliente inexistente) — útil para conferir a URL de redirecionamento gerada.
`POST /api/integrations/calendar/sync` com o segredo do cron responde `{"connections":0,...}` quando
não há conexões.
