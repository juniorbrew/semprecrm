/** pt-BR copy for products and services inside the deal (migration 104) — EN key → pt-BR. Loaded through ./index.ts. */
export const DICT_PRODUCTS: Record<string, string> = {
  // ---- Deal drawer: products and services of a deal ----
  'Products and services': 'Produtos e serviços',
  'Add item': 'Adicionar item',
  'Save item': 'Salvar item',
  'Edit item': 'Editar item',
  'Remove item': 'Remover item',
  'Item added': 'Item adicionado',
  'Item updated': 'Item atualizado',
  'Item removed': 'Item removido',
  'Could not load the items.': 'Não foi possível carregar os itens.',
  'Loading items…': 'Carregando itens…',
  'No products or services in this deal yet. The deal value is typed by hand until you add one.':
    'Este negócio ainda não tem produtos nem serviços. O valor é digitado à mão até você adicionar um.',
  'No products or services in this deal.': 'Este negócio não tem produtos nem serviços.',
  'The deal value is the sum of the items.': 'O valor do negócio é a soma dos itens.',
  'Items total': 'Total dos itens',
  'Line total': 'Total do item',
  'calculated from the items': 'calculado pelos itens',
  'Product or service name': 'Nome do produto ou serviço',
  'Search the catalog or type a name': 'Busque no catálogo ou digite um nome',
  'Catalog matches': 'Produtos do catálogo',
  'Price per unit': 'Preço de cada unidade',
  'Number of units': 'Quantidade de unidades',
  'Discount in percent': 'Desconto em porcentagem',
  'Use a comma for decimals, like 1,5': 'Use vírgula para decimais, ex.: 1,5',
  'A deal can have at most 200 items': 'Um negócio pode ter no máximo 200 itens',

  // ---- Validation (items and catalog) ----
  'Type the name of the product or service': 'Digite o nome do produto ou serviço',
  'The name can have at most 120 characters': 'O nome pode ter no máximo 120 caracteres',
  'The name can have at most 80 characters': 'O nome pode ter no máximo 80 caracteres',
  'The code can have at most 40 characters': 'O código pode ter no máximo 40 caracteres',
  'The description can have at most 300 characters': 'A descrição pode ter no máximo 300 caracteres',
  'Type a valid price, like 1.500,00': 'Digite um preço válido, como 1.500,00',
  'This price is too high': 'Este preço é alto demais',
  'Type a number of units above zero, like 2 or 1,5': 'Digite uma quantidade maior que zero, como 2 ou 1,5',
  'The number of units is too high': 'A quantidade de unidades é alta demais',
  'Type a discount from 0 to 100': 'Digite um desconto de 0 a 100',
  'This line is worth more than a deal can hold': 'Este item vale mais do que um negócio comporta',

  // ---- Database errors ----
  'A product with this name already exists': 'Já existe um produto ativo com este nome',
  'The items add up to more than the deal value limit': 'A soma dos itens passa do limite de valor de um negócio',
  'You do not have permission to change this, or the account is read-only':
    'Você não tem permissão para alterar isto, ou a conta está somente para leitura',
  'The data was rejected. Check the values and try again': 'Os dados foram recusados. Confira os valores e tente de novo',

  // ---- Settings: Produtos e serviços ----
  'What you sell. Add these to a deal and its value is calculated for you.':
    'O que você vende. Adicione ao negócio e o valor é calculado para você.',
  'Only owners and admins can change the catalog.': 'Só donos e administradores podem alterar o catálogo.',
  'Could not load the products.': 'Não foi possível carregar os produtos.',
  'Loading products…': 'Carregando produtos…',
  'Active products': 'Produtos ativos',
  'Archived products': 'Produtos arquivados',
  'They no longer appear when adding to a deal. Old deals keep them.':
    'Não aparecem mais ao adicionar a um negócio. Os negócios antigos continuam com eles.',
  'No products or services yet': 'Nenhum produto ou serviço ainda',
  'Register what you sell once, then pick it inside any deal.':
    'Cadastre o que você vende uma vez e escolha dentro de qualquer negócio.',
  'An owner or admin can register what you sell.': 'Um dono ou administrador pode cadastrar o que você vende.',
  'Add your first product': 'Cadastrar o primeiro produto',
  'New product or service': 'Novo produto ou serviço',
  'Edit product or service': 'Editar produto ou serviço',
  'The price is copied into each deal when you add it, so changing it later does not alter old deals.':
    'O preço é copiado para cada negócio quando você adiciona, então mudá-lo depois não altera os negócios antigos.',
  'Product code (optional)': 'Código do produto (opcional)',
  'Short description (optional)': 'Descrição curta (opcional)',
  'Save product': 'Salvar produto',
  'Product created': 'Produto criado',
  'Product updated': 'Produto atualizado',
  'Archive product': 'Arquivar produto',
  'Restore product': 'Reativar produto',
  'Product archived': 'Produto arquivado',
  'Product restored': 'Produto reativado',
};
