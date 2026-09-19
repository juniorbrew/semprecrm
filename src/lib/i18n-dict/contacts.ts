/** pt-BR copy for the "contacts" area (contacts, pipelines, tasks, calendar, dashboard) — EN key → pt-BR. Loaded through ./index.ts. */
export const DICT_CONTACTS: Record<string, string> = {
  // ---- Contact form ----
  'Edit contact': 'Editar contato',
  'Add contact': 'Adicionar contato',
  'Failed to save contact': 'Não foi possível salvar o contato',
  'Failed to load contacts': 'Não foi possível carregar os contatos',
  'Include the country code, e.g. +55 for Brazil':
    'Inclua o código do país, ex.: +55 para o Brasil',
  'email@example.com': 'email@exemplo.com',
  'Company name': 'Nome da empresa',
  contact: 'contato',
  contacts: 'contatos',

  // ---- Custom fields manager ----
  'Field created.': 'Campo criado.',
  'Field deleted.': 'Campo excluído.',
  'Rename field': 'Renomear campo',
  'This also removes its stored value on every contact. This cannot be undone.':
    'Isso também remove o valor salvo em todos os contatos. Esta ação não pode ser desfeita.',

  // ---- CSV import ----
  '(comma-separated; quote cells with more than one tag).':
    '(separadas por vírgula; use aspas nas células com mais de uma etiqueta).',

  // ---- Pipelines ----
  'Delete pipeline': 'Excluir funil',
  'e.g. Enterprise sales': 'ex.: Vendas corporativas',
  'How this metric is calculated': 'Como esta métrica é calculada',
  Qualified: 'Qualificado',
  Negotiation: 'Negociação',

  // ---- Dashboard ----
  Total: 'Total',

  // ---- Role gates (GatedButton tooltips) ----
  "Read-only — your role can't add or import contacts":
    'Somente leitura — seu perfil não pode adicionar ou importar contatos',
  "Read-only — your role can't delete contacts":
    'Somente leitura — seu perfil não pode excluir contatos',
  "Read-only — your role can't create pipelines":
    'Somente leitura — seu perfil não pode criar funis',
  "Read-only — your role can't create deals":
    'Somente leitura — seu perfil não pode criar negócios',
  "Read-only — your role can't create appointments":
    'Somente leitura — seu perfil não pode criar compromissos',
};
