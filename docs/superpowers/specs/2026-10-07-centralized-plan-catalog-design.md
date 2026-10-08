# Gestão centralizada dos planos do SempreCRM

Status: desenho aprovado pelo usuário em 2026-10-07; implementação e publicação ainda não iniciadas.

## Objetivo e decisão confirmada

Administradores da plataforma poderão editar preço anunciado, módulos e limites dos planos pelo painel, com regras consistentes no site, nas telas do CRM e nas verificações do servidor.

Decisão confirmada pelo usuário: preservar as condições das empresas atuais e usar as alterações somente nas próximas contratações. Cada empresa conservará a versão do plano recebida. As sobrescritas individuais continuam com prioridade.

## Primeira entrega proposta

- Nova seção **Planos** no painel administrativo, protegida pelas duas travas existentes.
- Edição dos quatro planos atuais: Teste, Básico, Pro e Empresa. Os identificadores permanecem os mesmos; criação ou exclusão de planos não entra nesta entrega.
- Preço mensal anunciado em reais, ou indicação de preço personalizado. Teste permanece gratuito, com duração de 14 dias.
- Seleção dos módulos opcionais e limites de usuários e canais. Caixa de entrada e Contatos permanecem obrigatórios.
- Prévia antes de salvar, com indicação de quais condições mudarão e de que as empresas atuais serão preservadas.
- Histórico das versões com autor, data e valores anteriores/novos. Uma edição válida cria uma versão, sem reescrever a anterior.
- A página pública de preços e a seção Planos mostram a versão vigente. Empresas atuais consultam sua versão concedida.

Preço anunciado é uma referência comercial, não o valor contratado por uma empresa. Esta entrega não cria cobranças automáticas nem altera valores cobrados. A migração não atribui retroativamente preços contratados às empresas existentes.

## Regras de concessão

1. A migração vincula as empresas existentes a versões iniciais que reproduzem exatamente os módulos e limites atuais. Situação, validade e ajustes individuais ficam preservados.
2. Novos cadastros recebem a versão vigente do Teste. Uma nova atribuição ou troca de plano pelo administrador recebe a versão vigente do plano escolhido.
3. Editar situação, validade, notas ou ajustes individuais mantendo o mesmo plano preserva a versão concedida.
4. Para aplicar condições novas a uma empresa que continua no mesmo plano, haverá uma ação explícita **Atualizar condições do plano**, com prévia dos efeitos antes de salvar. Não haverá atualização em massa nesta etapa.
5. Reduzir limites não apaga usuários, convites ou canais. As regras atuais impedem novas inclusões além da capacidade; a prévia e o resumo devem mostrar o excesso.

## Alternativas consideradas

- Manter tudo no código não atende à edição pelo painel.
- Alterar um catálogo global sem versões é mais simples, mas modifica clientes existentes. Foi descartado conforme a decisão do usuário.
- Registrar versões e vincular cada empresa à definição recebida atende à preservação das condições. É a abordagem escolhida.

## Arquitetura proposta

- Catálogo com os quatro identificadores e uma referência à versão vigente de cada um.
- Versões imutáveis com módulos, limites, preço anunciado em centavos, moeda BRL, autor e data.
- Referência da empresa à versão concedida. A relação deve garantir que a versão corresponde ao identificador do plano da empresa.
- O cálculo de permissões continua puro: recebe a definição concedida, aplica os ajustes individuais e mantém as regras de bloqueio atuais.
- Leitura centralizada da definição concedida para servidores, motores de automação e cliente. Listagem, resumo, alertas e prévia administrativa usam a mesma definição.
- Catálogo público expõe somente a definição vigente e dados comerciais; não expõe autores, histórico ou informação de empresas.

Pontos do projeto envolvidos: `src/lib/plans.ts`, `plans-server.ts`, `src/hooks/use-auth.tsx`, tipos e consultas das empresas, RPCs administrativos, formulários/listas da plataforma, navegação e página `/precos`. A migração deve acompanhar os privilégios por coluna e a proteção dos campos administrativos da migração 076.

## Segurança, consistência e erros

- Somente administradores da plataforma com a segunda trava aberta podem gravar pelo painel. Escrita direta de clientes é negada; funções de escrita privilegiada são chamadas exclusivamente por rotas autorizadas.
- Membros podem ler somente a definição necessária à sua própria empresa. Visitantes podem consultar apenas o catálogo vigente público.
- Validação no servidor e no banco: módulos conhecidos, limites inteiros não negativos ou ilimitados, preço inteiro não negativo ou personalizado, plano válido e revisão esperada.
- Gravação da nova versão, troca da referência vigente e auditoria são atômicas. Edições concorrentes retornam conflito e exigem recarregar, sem sobrescrever silenciosamente.
- Falha de carregamento ou definição inválida não concede os recursos do Teste como alternativa. Operações protegidas negam execução; a interface informa indisponibilidade e permite tentar novamente.
- Sem cache persistente de permissões inicialmente. Após salvar, a tela atualiza seus dados; o preço público é revalidado. Empresas abertas continuam usando a versão recebida.
- O histórico de catálogo fica separado do histórico por empresa. A adesão explícita de uma empresa a uma versão nova aparece no histórico daquela empresa, com detalhes permitidos.

## Migração e publicação

Migração aditiva: criar catálogo/versões, inserir os valores atuais, vincular empresas, configurar privilégios e proteger os novos campos. Não apagar tabelas, empresas ou configurações existentes. Primeiro validar na base local isolada. A publicação seguirá revisão independente, verificações automáticas e autorização do usuário.

## Critérios de aceitação

- Editar o plano Pro altera o catálogo vigente e o preço público, mas uma empresa Pro anterior conserva seus módulos, limites e sobrescritas.
- Uma nova adesão ao Pro recebe as condições novas. Alterar somente a situação de uma empresa anterior não muda suas condições.
- A ação explícita de atualização apresenta a diferença e aplica a nova versão preservando sobrescritas.
- Tela, APIs, convites, canais e automações concordam sobre os direitos e limites de cada empresa.
- Usuários comuns não gravam catálogo nem escolhem versões diretamente; dados de outra empresa e metadados internos não são expostos.
- Conflito de edição e falha de leitura/gravação têm mensagens claras e não geram alterações parciais.
- Testes do resolver, banco/RLS, rotas e integração cobrem preservação, novas adesões, ajustes individuais, segurança e concorrência. O navegador cobre edição/prévia, erros, histórico, temas claro/escuro e tamanhos desktop/mobile.

## Fora do escopo

Cobrança automática, checkout, integrações financeiras, descontos, planos arbitrários novos e atualização em massa de contratos.
