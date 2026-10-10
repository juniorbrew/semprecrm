# Alertas dos canais WhatsApp por empresa

Esta etapa acrescenta ao bloco **Precisam de atenção** os canais oficiais desconectados e as sessões QR desconectadas com sinais registrados de uso ou erro. Cada empresa aparece uma vez, mesmo quando tem dois canais sinalizados ou outros alertas. O link abre os detalhes existentes; **Atualizar visão geral** recarrega o registro.

Empresas sem canal e sessões QR vazias não recebem alerta de desconexão. Os estados `qr`, `connecting` e `connected` não são classificados como desconectados. O texto do painel deixa claro que se trata do último estado registrado, sem consulta ao provedor ao vivo.

## Implementação

- Migração aditiva `084_platform_channel_alerts.sql`: consulta administrativa que retorna somente identificadores e indicadores booleanos, em um único JSON para evitar truncamento dos alertas.
- A página verifica o acesso administrativo e o segundo login antes de consultar os dados. Falhas de leitura usam a tela de erro existente.
- O resumo, os filtros, os limites dos planos e as condições já concedidas permanecem nos fluxos existentes. Nenhuma escrita de empresa é adicionada à visão geral.
- Sem novas dependências, alterações de credenciais, reconexão automática ou modificações no gateway.

## Verificação

Os testes unitários novos falharam antes da implementação e passaram depois. A validação SQL executa em transação no banco isolado, cria dados fictícios e desfaz tudo ao final. Ela cobre ausência de canal, desconexão oficial, QR vazio/com telefone/com nome/com erro, conexão e conexão em andamento, proteção dos dados, autorização e 1.001 alertas.

Os resultados finais dos testes no navegador constam em `results.json`. As capturas `channel-alerts-desktop.png`, `channel-alerts-mobile.png` e `channel-alerts-mobile-light.png` mostram os novos alertas. As auditorias específicas ocorrem enquanto os alertas estão visíveis, em 375 px, nos dois temas.

Resultado final de 10/10/2026: **3.742 testes passaram** em 273 arquivos; um teste/arquivo previamente marcado como ignorado permaneceu assim. Compilação, checagem de tipos, lint dos arquivos alterados, formatação e verificação do diff passaram. Os **19 grupos de verificação no navegador passaram**, sem erros de console, requisições com falha ou violações nas auditorias dos alertas. As duas revisões independentes não encontraram bloqueios.

O Windows havia reservado a porta 58021 após reiniciar. A execução no navegador usou temporariamente a porta local 59021 com um proxy isolado, removido ao terminar. A configuração temporária foi restaurada; nenhuma credencial foi modificada. Os dados criados na execução foram removidos, e a contagem original de 47 empresas locais foi preservada.

Recursos utilizados: Superpowers para testes e verificação, Impeccable e práticas de React para preservar a interface, agent-browser para os fluxos reais e revisores independentes de SQL/segurança e interface/testes.

## Limites e publicação

Ainda não publicado. A aplicação depende da migração 084 antes da atualização do código. O banco produtivo e o gateway não foram alterados nesta etapa.

O estado registrado pode estar desatualizado; uma consulta posterior ao gateway pode apagar sinais anteriores de desconexão QR. A listagem administrativa de empresas mantém seu limite anterior de retorno; o novo agregado de alertas foi verificado acima de 1.000 registros, mas não altera essa listagem.

A base da implementação é `ebce337` (main). A última publicação conhecida era `6157aa9`; as alterações intermediárias, incluindo a migração 083, precisam ser consideradas explicitamente na preparação da implantação.
