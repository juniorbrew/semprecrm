# Página de agendamento — entrar com e-mail ou Google

Data: 2026-11-16 · Branch `feat/agendamento-login` · Worktree `C:\SempreCRM-agendar-login` · Migration **114** (os extras da Entrega 10 passam a 115).
Continua a parte 1 (PR #142, migration 113).

## Decisões do dono (2026-11-16)
- Além do WhatsApp: **e-mail com código** e **Google**. Apple fica para depois (exige conta de desenvolvedor Apple).
- Quem entra por e-mail/Google **informa o celular, mas não confirma** (para os lembretes).

## Regra de segurança (o que muda e o que não muda)
- **WhatsApp (como hoje):** prova o celular → a sessão é do **contato** → "Meus horários" mostra os horários do contato.
- **E-mail/Google:** prova só o e-mail/conta → a sessão é da **identidade** (e-mail ou conta Google) → "Meus horários" mostra **só os horários marcados por essa identidade**. Nunca abre os horários de um contato existente só porque o celular digitado bate.
- O horário é registrado no contato do celular digitado (acha pelo número exato, com a variante do 9º dígito; senão cria). Na agenda do CRM aparece a nota "Agendado pelo link (entrou com Google) — celular não confirmado"; o nome mostrado é o que a pessoa digitou (pedido do dono: nome, não e-mail).
- Limites: o limite de horários futuros vale para a identidade **e** para o contato (a trava do banco da 113 continua).
- Risco aceito (igual a qualquer formulário de agendamento): alguém pode digitar o celular de outra pessoa; ela receberá os lembretes daquele horário. Fica visível para a empresa pela nota.

## Fluxo do cliente
1. Escolhe serviço → profissional → horário (igual).
2. Tela "Como você quer continuar?": **Continuar com Google** · **Continuar com e-mail** · **Confirmar pelo WhatsApp**.
3. Google: vai ao Google, volta para a página já logado; o horário escolhido é retomado.
   E-mail: digita o e-mail → recebe código de 6 números → digita na página.
4. Se a identidade ainda não tem celular: pede nome + celular (+ aviso LGPD) e agenda.
5. "Meus horários" e "Sair de todos os aparelhos" funcionam para os dois tipos de sessão.

## Banco — migration 114
- `booking_identities`: conta, tipo (`email`|`google`), identificador (e-mail minúsculo ou `sub` do Google), e-mail, nome, `contact_id` (depois do 1º horário), `revoked_before`. Único por (conta, tipo, identificador). Só service role.
- `booking_email_codes`: conta, página, e-mail, **hash** do código, hash do segredo do aparelho, tentativas, validade 10 min. Só service role.
- `booking_identity_events`: qual identidade marcou qual horário (conta, identidade, evento). Só service role.
- `booking_client_book` ganha `p_identity_id` (opcional): na mesma transação conta os futuros da identidade e grava o vínculo.

## Servidor
- Sessão assinada passa a ter `c` (contato, WhatsApp) **ou** `i` (identidade). Nada muda para quem já entrou pelo WhatsApp.
- E-mail: `POST /api/agendar/[slug]/email` (envia código) e `POST /api/agendar/[slug]/email/verificar`. Limites por IP, por e-mail+IP e por página; 5 tentativas; código guardado só como hash.
- Google: `GET /api/agendar/google/iniciar?pagina=<slug>` e `GET /api/agendar/google/retorno` (endereço fixo, a página vai no `state` assinado + nonce em cookie). Reaproveita `GOOGLE_CLIENT_ID/SECRET` da agenda; escopos `openid email profile`; só aceita e-mail verificado pelo Google.
- Os botões só aparecem quando o servidor tem e-mail (SMTP) / Google configurados.

## O que o dono precisa fazer (Google)
No Google Cloud Console, no mesmo cliente OAuth da agenda: adicionar o endereço de retorno
`https://www.semprecrm.com.br/api/agendar/google/retorno` (e o de teste `http://localhost:3101/api/agendar/google/retorno`), e a tela de consentimento precisa estar **em produção** (não "teste"), senão só os e-mails de teste conseguem entrar.

## Fora desta parte
Apple, lembrete por e-mail, confirmar o celular depois de logado.

## Verificação
Testes das regras (sessão com identidade, código de e-mail, vínculo), teste no banco local (identidade não vê horários do contato; limites), suíte completa, navegador (e-mail com SMTP local de teste; Google com cliente real só se o dono configurar o endereço de teste), revisão de código + segurança.
