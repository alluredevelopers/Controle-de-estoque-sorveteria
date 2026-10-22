import { ALLOWED_UNITS, PERMISSIONS } from './constants.js'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const LOGIN_PATTERN = /^[a-z0-9][a-z0-9._@+-]{2,79}$/

export class HttpError extends Error {
  constructor(status, message, code = undefined) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

export function text(value) {
  return String(value ?? '').trim()
}

export function requiredText(value, field, max = 150) {
  const result = text(value)
  if (!result) throw new HttpError(400, `${field} é obrigatório.`)
  if (result.length > max) throw new HttpError(400, `${field} deve ter no máximo ${max} caracteres.`)
  return result
}

export function optionalText(value, max = 500) {
  const result = text(value)
  if (result.length > max) throw new HttpError(400, `O texto deve ter no máximo ${max} caracteres.`)
  return result || null
}

export function optionalEmail(value) {
  const email = text(value).toLowerCase()
  if (!email) return null
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) throw new HttpError(400, 'Informe um e-mail válido.')
  return email
}

export function normalizeLogin(value) {
  const login = requiredText(value, 'Login', 80).toLowerCase()
  if (!LOGIN_PATTERN.test(login) && !EMAIL_PATTERN.test(login)) {
    throw new HttpError(400, 'O login deve ter entre 3 e 80 caracteres, usar letras, números e símbolos simples, ou ser um e-mail válido.')
  }
  return login
}

export function validatePassword(value, { temporary = false } = {}) {
  const password = requiredText(value, 'Senha', 200)
  const minimum = temporary ? 10 : 10
  if (password.length < minimum) throw new HttpError(400, `A senha deve ter pelo menos ${minimum} caracteres.`)
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new HttpError(400, 'A senha deve conter pelo menos uma letra e um número.')
  }
  return password
}

function decimalString(value, field, { allowZero, fallback, maximumFractionDigits = 3 } = {}) {
  const raw = value === '' || value === null || value === undefined ? fallback : value
  const normalized = text(raw).replace(',', '.')
  const pattern = new RegExp(`^\\d+(?:\\.\\d{1,${maximumFractionDigits}})?$`)
  if (!pattern.test(normalized)) {
    throw new HttpError(400, `${field} deve ser um número com no máximo ${maximumFractionDigits} casa(s) decimal(is).`)
  }
  const number = Number(normalized)
  if (!Number.isFinite(number) || number < 0 || (!allowZero && number === 0)) {
    throw new HttpError(400, `${field} deve ser um número ${allowZero ? 'igual ou maior que zero' : 'maior que zero'}.`)
  }
  if (number > 999_999_999) throw new HttpError(400, `${field} excede o limite permitido.`)
  const [integerPart, decimalPart] = normalized.split('.')
  const canonicalInteger = integerPart.replace(/^0+(?=\d)/, '') || '0'
  return decimalPart ? `${canonicalInteger}.${decimalPart}` : canonicalInteger
}

export function positiveDecimal(value, field) {
  return decimalString(value, field, { allowZero: false })
}

export function nonNegativeDecimal(value, field, fallback = '0') {
  return decimalString(value, field, { allowZero: true, fallback })
}

export function nonNegativeMoney(value, field, fallback = '0') {
  return decimalString(value, field, { allowZero: true, fallback, maximumFractionDigits: 2 })
}

export function positiveNumber(value, field) {
  return Number(positiveDecimal(value, field))
}

export function nonNegativeNumber(value, field, fallback = 0) {
  const raw = value === '' || value === null || value === undefined ? fallback : value
  const normalized = text(raw).replace(',', '.')
  const number = Number(normalized)
  if (!Number.isFinite(number) || number < 0) {
    throw new HttpError(400, `${field} deve ser um número igual ou maior que zero.`)
  }
  if (number > 999_999_999) throw new HttpError(400, `${field} excede o limite permitido.`)
  return number
}

export function uuid(value, field = 'Identificador') {
  const result = text(value)
  if (!UUID_PATTERN.test(result)) throw new HttpError(400, `${field} inválido.`)
  return result
}

export function optionalUuid(value, field = 'Identificador') {
  const result = text(value)
  return result ? uuid(result, field) : null
}

export function normalizeUnit(value) {
  const unit = requiredText(value, 'Unidade', 30).toLowerCase()
  if (!ALLOWED_UNITS.includes(unit)) throw new HttpError(400, 'Unidade de medida inválida.')
  return unit
}

export function normalizePermissions(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    [PERMISSIONS.CREATE_PRODUCTS]: source[PERMISSIONS.CREATE_PRODUCTS] === true,
    [PERMISSIONS.STOCK_ENTRY]: source[PERMISSIONS.STOCK_ENTRY] === true,
    [PERMISSIONS.STOCK_EXIT]: source[PERMISSIONS.STOCK_EXIT] === true,
  }
}

export function hasPermission(user, permission) {
  return user?.role === 'admin' || user?.permissions?.['*'] === true || user?.permissions?.[permission] === true
}

export function requireAdmin(user) {
  if (user?.role !== 'admin') throw new HttpError(403, 'Esta função é exclusiva do administrador.')
}

export function requirePermission(user, permission, message = 'Você não tem permissão para esta ação.') {
  if (!hasPermission(user, permission)) throw new HttpError(403, message)
}

export function stockStatus(quantity, criticalStock, lowStock) {
  const quantityNumber = Number(quantity || 0)
  const criticalNumber = Number(criticalStock || 0)
  const lowNumber = Number(lowStock || 0)
  if (quantityNumber <= criticalNumber) return 'critical'
  if (quantityNumber <= lowNumber) return 'low'
  return 'good'
}

export function validateThresholds(criticalValue, lowValue) {
  const criticalStock = nonNegativeNumber(criticalValue, 'Limite crítico')
  const lowStock = nonNegativeNumber(lowValue, 'Limite baixo')
  if (criticalStock > lowStock) {
    throw new HttpError(400, 'O limite crítico não pode ser maior que o limite baixo.')
  }
  return { criticalStock, lowStock }
}

export function parsePagination(url, { defaultSize = 20, maxSize = 100, maxPage = 1_000_000 } = {}) {
  const parsedPage = Number.parseInt(url.searchParams.get('page') || '1', 10) || 1
  const page = Math.min(maxPage, Math.max(1, parsedPage))
  const pageSize = Math.min(maxSize, Math.max(1, Number.parseInt(url.searchParams.get('page_size') || String(defaultSize), 10) || defaultSize))
  return { page, pageSize, offset: (page - 1) * pageSize }
}

export function parseDate(value, field, { endOfDay = false } = {}) {
  const raw = text(value)
  if (!raw) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (!match) throw new HttpError(400, `${field} inválida.`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const calendarCheck = new Date(Date.UTC(year, month - 1, day))
  if (
    calendarCheck.getUTCFullYear() !== year
    || calendarCheck.getUTCMonth() !== month - 1
    || calendarCheck.getUTCDate() !== day
  ) {
    throw new HttpError(400, `${field} inválida.`)
  }
  const time = endOfDay ? '23:59:59.999' : '00:00:00.000'
  return new Date(`${raw}T${time}-03:00`).toISOString()
}

export function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  if (value === true || value === 'true' || value === 1 || value === '1') return true
  if (value === false || value === 'false' || value === 0 || value === '0') return false
  throw new HttpError(400, 'Valor booleano inválido.')
}
