/** pt-BR copy for the "misc" area — EN key → pt-BR. Loaded through ./index.ts. */
export const DICT_MISC: Record<string, string> = {
  // ---- 404 page (src/app/not-found.tsx) ----
  'Page not found': 'Página não encontrada',
  'The address you opened does not exist or was moved. Check the link or go back to the start.':
    'O endereço que você abriu não existe ou foi movido. Confira o link ou volte para o início.',
  'Go to the start': 'Ir para o início',

  // ---- Blocked screen (plans) — the original key carries a trailing
  // space, which the DOM walker trims before the lookup. ----
  'Support:': 'Suporte:',

  // ---- GatedButton read-only tooltips (title attribute) ----
  "Read-only — your role can't add or import contacts":
    'Somente leitura — seu perfil não pode adicionar ou importar contatos',
  "Read-only — your role can't delete contacts":
    'Somente leitura — seu perfil não pode excluir contatos',
  "Read-only — your role can't create appointments":
    'Somente leitura — seu perfil não pode criar compromissos',
  "Read-only — your role can't create automations":
    'Somente leitura — seu perfil não pode criar automações',
  "Read-only — your role can't create broadcasts":
    'Somente leitura — seu perfil não pode criar disparos',
  "Read-only — your role can't create deals":
    'Somente leitura — seu perfil não pode criar negócios',
  "Read-only — your role can't create flows":
    'Somente leitura — seu perfil não pode criar fluxos',
  "Read-only — your role can't create pipelines":
    'Somente leitura — seu perfil não pode criar funis',

  // ---- Hook errors surfaced in toasts (src/hooks/use-broadcast-sending.ts) ----
  'You are not signed in.': 'Você não está conectado.',
  'No contacts found for this audience.': 'Nenhum contato encontrado para este público.',
  'Failed to fetch broadcast recipients': 'Não foi possível carregar os destinatários do disparo',

  // ---- Push notification bodies (src/lib/push/notify.ts) ----
  Video: 'Vídeo',
  Document: 'Documento',
  Sticker: 'Figurinha',
  Reaction: 'Reação',
  'Unsupported message': 'Mensagem não suportada',
};
