export const PERMISSIONS = Object.freeze({
  CREATE_PRODUCTS: 'products.create',
  STOCK_ENTRY: 'stock.entry',
  STOCK_EXIT: 'stock.exit',
})

export const COLLABORATOR_PERMISSION_OPTIONS = Object.freeze([
  { key: PERMISSIONS.CREATE_PRODUCTS, label: 'Cadastrar produtos' },
  { key: PERMISSIONS.STOCK_ENTRY, label: 'Registrar entradas' },
  { key: PERMISSIONS.STOCK_EXIT, label: 'Registrar saídas' },
])

export const ALLOWED_UNITS = Object.freeze([
  'unidade',
  'caixa',
  'pacote',
  'quilo',
  'grama',
  'litro',
  'mililitro',
  'pote',
  'garrafa',
  'lata',
  'saco',
  'outro',
])

export const DEFAULT_CATEGORIES = Object.freeze([
  'Sorvetes',
  'Picolés',
  'Açaí Caixa',
  'Açaí Pote',
  'Creme',
  'Descartáveis',
  'Complementos',
])

export const SESSION_COOKIE = 'pinguins_session'
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60
