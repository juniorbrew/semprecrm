# Usuários, canais e histórico da empresa

Implementação e verificação local em 07/10/2026, com dados sintéticos no Supabase isolado.

A ficha administrativa agora oferece três abas abaixo do resumo salvo:

- Usuários: nome, e-mail e função, mais convites pendentes válidos e seu vencimento.
- Canais: configurações de WhatsApp oficial e QR, identificação, estado registrado e última atualização. Não chama o gateway nem promete conexão em tempo real.
- Histórico: ação registrada, responsável e data no horário da Bahia, com paginação.

As listas carregam sob demanda, em páginas de 25 itens com cursor por data e ID, incluindo registros com a mesma data. Atualizar lista, carregar mais e tentar novamente preservam o formulário ainda não salvo. Não há ações de gestão de usuários/canais nesta etapa.

O endpoint exige administrador de plataforma e segundo login, valida a empresa antes de criar o cliente privilegiado, restringe todas as consultas à empresa selecionada e envia apenas campos permitidos. Não envia tokens, hashes, erros técnicos ou metadados livres de auditoria. Respostas privadas sem cache. Sem migrações, dependências novas ou alteração de credenciais.

## Evidências

- 59 testes aprovados em cinco arquivos; 16 casos do endpoint novo cobrem autorização, gate, validação, isolamento, projeção segura, convites, erros e paginação.
- ESLint dos arquivos alterados, formatação dos arquivos novos/modificados e `git diff --check` aprovados.
- Compilação de produção e checagem de tipos aprovadas. A primeira execução esgotou memória local; execução final com dois workers aprovada, sem mudança de configuração do projeto.
- Onze verificações reais de navegador aprovadas: `results.json`.
- Fixture com convites pendente/aceito/expirado, dois canais, nome de canal longo, 26 eventos com timestamp igual e evento de outra empresa.
- Paginação sem duplicação, dados de outra empresa e campos secretos sintéticos excluídos, recuperação de resposta inválida, atualização e estados vazios verificados.
- Layouts de 1440, 768 e 375 pixels sem rolagem horizontal, inclusive canal com nome longo.
- Auditorias axe da ficha e visão geral nos temas claro e escuro sem violações; nenhum erro de navegador ou requisição malsucedida.
- Revisões independentes de segurança e interface sem pendências; recomendação de conter nome longo de canal aplicada e verificada.

Capturas principais: `company-users-1440.png`, `company-users-375.png`, `company-channels-375.png`, `company-activity-1440.png`, `company-activity-375.png` e `company-activity-light.png`. Todos os dados pessoais e identificadores nas capturas são sintéticos.

Recursos: Superpowers, Impeccable, orientações de React/Vercel, agent-browser e revisões independentes. O subagente da interface iniciou o componente e interrompeu por limite de uso; a implementação e validação foram concluídas pelo agente principal.

Esta etapa está preparada localmente. Publicação depende de autorização do usuário.
