import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HttpError,
  booleanValue,
  normalizeLogin,
  normalizeUnit,
  nonNegativeMoney,
  normalizePermissions,
  parseDate,
  parsePagination,
  positiveDecimal,
  stockStatus,
  validatePassword,
  validateThresholds,
} from '../api/lib/validation.js'
import { PERMISSIONS } from '../api/lib/constants.js'

test('normaliza logins válidos', () => {
  assert.equal(normalizeLogin(' Gestao.Estoque '), 'gestao.estoque')
  assert.equal(normalizeLogin(' Gestao@example.com '), 'gestao@example.com')
  assert.equal(normalizeLogin(' gestao+loja@example.com '), 'gestao+loja@example.com')
})

test('rejeita login curto ou com espaço', () => {
  assert.throws(() => normalizeLogin('ab'), HttpError)
  assert.throws(() => normalizeLogin('gestao estoque'), HttpError)
})

test('normaliza apenas permissões conhecidas', () => {
  assert.deepEqual(normalizePermissions({
    [PERMISSIONS.CREATE_PRODUCTS]: true,
    [PERMISSIONS.STOCK_ENTRY]: false,
    admin: true,
  }), {
    [PERMISSIONS.CREATE_PRODUCTS]: true,
    [PERMISSIONS.STOCK_ENTRY]: false,
    [PERMISSIONS.STOCK_EXIT]: false,
  })
})

test('valida os limites de estoque', () => {
  assert.deepEqual(validateThresholds('3', '8'), { criticalStock: 3, lowStock: 8 })
  assert.throws(() => validateThresholds('9', '8'), HttpError)
})

test('classifica o estoque nos três níveis', () => {
  assert.equal(stockStatus(2, 3, 8), 'critical')
  assert.equal(stockStatus(5, 3, 8), 'low')
  assert.equal(stockStatus(9, 3, 8), 'good')
})

test('exige senha com letra, número e tamanho mínimo', () => {
  assert.equal(validatePassword('Sorvete2026'), 'Sorvete2026')
  assert.throws(() => validatePassword('somenteletras'), HttpError)
  assert.throws(() => validatePassword('1234567890'), HttpError)
})


test('normaliza quantidades decimais sem perder precisão textual', () => {
  assert.equal(positiveDecimal('001,250', 'Quantidade'), '1.250')
  assert.equal(positiveDecimal('0.001', 'Quantidade'), '0.001')
  assert.throws(() => positiveDecimal('1.2345', 'Quantidade'), HttpError)
  assert.throws(() => positiveDecimal('0', 'Quantidade'), HttpError)
})

test('limita valores monetários a duas casas decimais', () => {
  assert.equal(nonNegativeMoney('12,50', 'Custo'), '12.50')
  assert.equal(nonNegativeMoney('', 'Custo'), '0')
  assert.throws(() => nonNegativeMoney('12.345', 'Custo'), HttpError)
})

test('interpreta filtros de data no fuso da Bahia e rejeita datas inexistentes', () => {
  assert.equal(parseDate('2026-10-21', 'Data inicial'), '2026-10-21T03:00:00.000Z')
  assert.equal(parseDate('2026-10-21', 'Data final', { endOfDay: true }), '2026-10-22T02:59:59.999Z')
  assert.throws(() => parseDate('2026-02-31', 'Data inicial'), HttpError)
})


test('rejeita valores booleanos ambíguos', () => {
  assert.equal(booleanValue(true), true)
  assert.equal(booleanValue('false'), false)
  assert.throws(() => booleanValue('sim'), HttpError)
})

test('padroniza unidades e rejeita unidade livre', () => {
  assert.equal(normalizeUnit(' Litro '), 'litro')
  assert.throws(() => normalizeUnit('balde grande'), HttpError)
})

test('limita paginação para evitar consultas excessivas', () => {
  const url = new URL('https://estoque.local/products?page=-4&page_size=9999')
  assert.deepEqual(parsePagination(url, { maxSize: 100 }), { page: 1, pageSize: 100, offset: 0 })
})
