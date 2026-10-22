export const PERMISSIONS = Object.freeze({
  CREATE_PRODUCTS: 'products.create',
  STOCK_ENTRY: 'stock.entry',
  STOCK_EXIT: 'stock.exit',
})

export const UNITS = Object.freeze([
  ['unidade', 'Unidade'],
  ['caixa', 'Caixa'],
  ['pacote', 'Pacote'],
  ['quilo', 'Quilo'],
  ['grama', 'Grama'],
  ['litro', 'Litro'],
  ['mililitro', 'Mililitro'],
  ['pote', 'Pote'],
  ['garrafa', 'Garrafa'],
  ['lata', 'Lata'],
  ['saco', 'Saco'],
  ['outro', 'Outro'],
])

export function hasPermission(user, permission) {
  return user?.role === 'admin' || user?.permissions?.['*'] === true || user?.permissions?.[permission] === true
}

export function formatNumber(value, maximumFractionDigits = 3) {
  return Number(value || 0).toLocaleString('pt-BR', { maximumFractionDigits })
}

export function formatMoney(value) {
  return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export function formatDateTime(value) {
  if (!value) return 'Não informado'
  return new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Bahia' })
}

export function statusLabel(status) {
  return ({ critical: 'Crítico', low: 'Baixo', good: 'Bom' })[status] || status
}

export function movementTypeLabel(type) {
  return type === 'entrada' ? 'Entrada' : 'Saída'
}

export function movementOriginLabel(origin) {
  return ({ manual: 'Lançamento', adjustment: 'Ajuste', annulment: 'Reversão' })[origin] || origin
}

export function newIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  if (!globalThis.crypto?.getRandomValues) throw new Error('Este navegador não oferece geração segura de identificadores.')
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function todayIso() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bahia',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}
