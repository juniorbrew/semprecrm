/** pt-BR copy for the "companies" area (Empresas — customer companies, migration 054) — EN key → pt-BR. Loaded through ./index.ts. */
export const DICT_COMPANIES: Record<string, string> = {
  // ---- Page / navigation ----
  Companies: 'Empresas',
  'Your customer companies, with their contacts and deals.':
    'Suas empresas clientes, com os contatos e negócios de cada uma.',
  'New company': 'Nova empresa',
  'Edit company': 'Editar empresa',
  'Create company': 'Criar empresa',
  'Delete company': 'Excluir empresa',
  'Open company': 'Abrir empresa',
  'Company details': 'Detalhes da empresa',
  'Search companies': 'Buscar empresas',
  'Search by name or CNPJ…': 'Buscar por nome ou CNPJ…',
  'No companies found': 'Nenhuma empresa encontrada',
  'No companies match your search.': 'Nenhuma empresa corresponde à sua busca.',
  'No companies yet.': 'Ainda não há empresas.',
  'Add your first company': 'Cadastre sua primeira empresa',
  Page: 'Página',
  'Previous page': 'Página anterior',
  'Next page': 'Próxima página',
  "Read-only — your role can't add companies": 'Somente leitura — seu perfil não pode cadastrar empresas',
  'Its contacts and deals are kept; they just stop pointing to this company. This cannot be undone.':
    'Os contatos e negócios dela são mantidos; só deixam de apontar para esta empresa. Esta ação não pode ser desfeita.',

  // ---- Form ----
  'Type the CNPJ and click "Fetch data" to fill in the rest from the Receita Federal.':
    'Digite o CNPJ e clique em "Buscar dados" para preencher o resto com os dados da Receita Federal.',
  'Fetch data': 'Buscar dados',
  'Trade name': 'Nome fantasia',
  'Main activity': 'Atividade principal',
  'Looking up the CNPJ…': 'Consultando o CNPJ…',
  'Data filled in — check before saving': 'Dados preenchidos — confira antes de salvar',
  'Data filled in — registration status:': 'Dados preenchidos — situação cadastral:',
  'CNPJ not found in the public sources — fill in by hand':
    'CNPJ não encontrado nas fontes públicas — preencha à mão',
  'Too many lookups — wait a minute and try again':
    'Muitas consultas seguidas — aguarde um minuto e tente de novo',
  'Could not reach the CNPJ services — fill in by hand':
    'Não foi possível consultar os serviços de CNPJ — preencha à mão',
  'This CNPJ is already registered in this account:': 'Este CNPJ já está cadastrado nesta conta:',
  'Check the highlighted fields': 'Confira os campos destacados',
  'The CNPJ lookup took too long — try again or fill in by hand':
    'A consulta do CNPJ demorou demais — tente de novo ou preencha à mão',
  'max. 20 characters': 'máx. 20 caracteres',
  'Link this company': 'Vincular esta empresa',
  'The company data was rejected — check the CNPJ, CEP, UF and field sizes':
    'Os dados da empresa foram recusados — confira CNPJ, CEP, UF e o tamanho dos campos',
  "The contact's primary company was changed at the same time — please try again":
    'A empresa principal do contato foi alterada ao mesmo tempo — tente de novo',
  'Failed to load deals': 'Não foi possível carregar os negócios',
  'Deals loaded without their companies — reload the page to try again':
    'Negócios carregados sem as empresas — recarregue a página para tentar de novo',
  Required: 'Obrigatório',
  'Too long': 'Muito longo',

  // ---- Results / errors ----
  'Company created': 'Empresa criada',
  'Company updated': 'Empresa atualizada',
  'Company deleted': 'Empresa excluída',
  'Company removed': 'Empresa removida',
  'Company not found': 'Empresa não encontrada',
  'A company with this CNPJ already exists': 'Já existe uma empresa com este CNPJ',
  'This contact is already linked to this company': 'Este contato já está vinculado a esta empresa',
  'You do not have permission to change companies': 'Você não tem permissão para alterar empresas',

  // ---- Contacts ↔ companies ----
  'Link contact': 'Vincular contato',
  'Unlink contact': 'Desvincular contato',
  'Contact linked': 'Contato vinculado',
  'Contact unlinked': 'Contato desvinculado',
  'Search contacts': 'Buscar contatos',
  'No contacts linked to this company yet': 'Ainda não há contatos vinculados a esta empresa',
  'No deals linked to this company yet': 'Ainda não há negócios vinculados a esta empresa',
  Primary: 'Principal',
  "This is the contact's primary company": 'Esta é a empresa principal do contato',
  'Companies of this contact': 'Empresas deste contato',
  'Link company': 'Vincular empresa',
  'Create a new company': 'Cadastrar nova empresa',
  'No companies linked yet': 'Ainda não há empresas vinculadas',
  'Mark as primary': 'Tornar principal',
  'Company linked': 'Empresa vinculada',
  'Company unlinked': 'Empresa desvinculada',
  'Primary company updated': 'Empresa principal atualizada',

  // ---- Deal company ----
  'No company': 'Sem empresa',
  'Choose company': 'Escolher empresa',
  'Change company': 'Trocar empresa',
  'Remove company': 'Tirar empresa',
  "Contact's primary company": 'Empresa principal do contato',
};
