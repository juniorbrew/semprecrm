/** pt-BR copy for the deal fields and formula fields (migration 107) — EN key → pt-BR. Loaded through ./index.ts.
 *  Field names, values and formula text are user data: the components mark them data-no-translate. */
export const DICT_DEAL_FIELDS: Record<string, string> = {
  // ---- Settings: tabs and list ----
  'Contact fields': 'Campos do contato',
  'Deal fields': 'Campos do negócio',
  'Numbers each deal carries, like cost or freight. A formula field calculates from them.':
    'Números que cada negócio carrega, como custo ou frete. Um campo com fórmula faz a conta a partir deles.',
  'New deal field': 'Novo campo do negócio',
  'Edit deal field': 'Editar campo do negócio',
  'No deal fields yet': 'Ainda não há campos do negócio',
  'Create a number field, like cost, then a formula field, like margin.':
    'Crie um campo de número, como o custo, e depois um campo com fórmula, como a margem.',
  'An owner or admin can create deal fields.': 'Um dono ou administrador pode criar os campos do negócio.',
  'Loading fields…': 'Carregando campos…',
  'Could not load the fields.': 'Não foi possível carregar os campos.',
  'On the card': 'No cartão',
  'Number field': 'Campo de número',
  'Money field': 'Campo de dinheiro',
  'Percentage field': 'Campo de porcentagem',
  'Formula field': 'Campo com fórmula',
  'Show as a number': 'Mostrar como número',
  'Show as money': 'Mostrar como dinheiro',
  'Show as a percentage': 'Mostrar como porcentagem',
  // ---- Settings: field dialog ----
  'Field type': 'Tipo do campo',
  'Result format': 'Formato do resultado',
  'Show on the pipeline card': 'Mostrar no cartão do Funil',
  'At most 2 fields can show on the card': 'No máximo 2 campos podem aparecer no cartão',
  'Save field': 'Salvar campo',
  'Field updated': 'O campo foi atualizado',
  'Field deleted': 'O campo foi excluído',
  'This also removes the value of this field on every deal. This cannot be undone.':
    'Isso também apaga o valor deste campo em todos os negócios. Não dá para desfazer.',
  'These formulas use this field and will stop working until you edit them:':
    'Estas fórmulas usam este campo e vão parar de funcionar até você editá-las:',
  // ---- Formula editor ----
  'Calculation formula': 'Fórmula do cálculo',
  'Insert a field into the formula': 'Inserir um campo na fórmula',
  'You can use + − × ÷ and parentheses. Type 0,05 for 5%.':
    'Você pode usar + − × ÷ e parênteses. Digite 0,05 para 5%.',
  'Preview with sample numbers': 'Prévia com números de exemplo',
  // ---- Validation ----
  'Type a name for the field': 'Digite um nome para o campo',
  'The name can have at most 40 characters': 'O nome pode ter no máximo 40 caracteres',
  'The name cannot contain { } or control characters': 'O nome não pode ter { }, nem caracteres de controle',
  'Two fields have this name. Rename one of them': 'Dois campos têm este nome. Renomeie um deles',
  'This name is used by a number of the deal (Valor, Chance, Itens, Dias para fechar)':
    'Este nome já é usado por um número do negócio (Valor, Chance, Itens, Dias para fechar)',
  'A field with this name already exists': 'Já existe um campo com este nome',
  'An account can have at most 50 deal fields': 'Cada conta pode ter no máximo 50 campos do negócio',
  'Type the formula': 'Digite a fórmula',
  'The formula can have at most 300 characters': 'A fórmula pode ter no máximo 300 caracteres',
  'The formula is too complex': 'A fórmula está complexa demais',
  'Check the parentheses: one is open or closed without a match':
    'Confira os parênteses: um foi aberto ou fechado sem par',
  'There is nothing inside the parentheses': 'Não há nada dentro dos parênteses',
  'Only numbers, fields in braces, + − × ÷ and parentheses are allowed':
    'Só são aceitos números, campos entre chaves, + − × ÷ e parênteses',
  'This number is not valid. Use one comma or dot for decimals, like 0,05':
    'Este número não é válido. Use uma vírgula ou um ponto para os decimais, como 0,05',
  'A field name is missing its closing brace }': 'Falta fechar a chave } do nome de um campo',
  'This field does not exist': 'Este campo não existe',
  'A formula cannot use another formula': 'Uma fórmula não pode usar outra fórmula',
  'The calculation is incomplete: an operator is missing a number':
    'A conta está incompleta: falta um número depois de uma operação',
  'Put an operator (+ − × ÷) between the values': 'Coloque uma operação (+ − × ÷) entre os valores',
  // ---- Deal drawer and form ----
  'Fields of this deal': 'Campos deste negócio',
  'Edit value': 'Editar valor',
  'Fill in': 'Preencha o campo',
  'Deleted field': 'Campo excluído',
  'Cannot divide by zero': 'Não dá para dividir por zero',
  'The number is too large': 'O número é grande demais',
  'Type a valid number, like 12,5': 'Digite um número válido, como 12,5',
  'Check the deal fields': 'Confira os campos do negócio',
  'The deal was saved, but some field values were not':
    'O negócio foi salvo, mas alguns valores de campos não foram',
}
