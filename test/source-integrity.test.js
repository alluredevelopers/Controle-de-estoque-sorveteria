import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = relativePath => readFileSync(join(root, relativePath), 'utf8')

const api = read('api/index.js')
const app = read('src/App.jsx')
const security = read('api/lib/security.js')
const packageJson = JSON.parse(read('package.json'))

function functionSource(source, functionName, nextFunctionName) {
  const start = source.indexOf(`function ${functionName}`)
  assert.notEqual(start, -1, `Função ${functionName} não encontrada.`)
  const end = nextFunctionName ? source.indexOf(`function ${nextFunctionName}`, start + 1) : source.length
  return source.slice(start, end === -1 ? source.length : end)
}

test('não usa armazenamento de sessão acessível ao JavaScript', () => {
  assert.doesNotMatch(app, /\blocalStorage\b|\bsessionStorage\b/)
  assert.match(security, /HttpOnly/)
  assert.match(security, /SameSite=Lax/)
})

test('não usa gerador aleatório inseguro para credenciais ou chaves', () => {
  const sources = [api, app, read('src/utils.js'), security].join('\n')
  assert.doesNotMatch(sources, /Math\.random\s*\(/)
  assert.match(security, /crypto\.randomInt/)
})

test('movimentações não são apagadas fisicamente', () => {
  assert.doesNotMatch(api, /DELETE\s+FROM\s+stock_movements/i)
  assert.match(api, /movement\.annulled/)
  assert.match(api, /reversal_movement_id/)
})

test('edição comum de produto não altera o saldo', () => {
  const updateProduct = functionSource(api, 'updateProduct', 'findIdempotentMovement')
  assert.doesNotMatch(updateProduct, /SET\s+quantity\s*=/i)
  assert.match(updateProduct, /critical_stock/)
  assert.match(updateProduct, /low_stock/)
})

test('categoria é opcional no frontend e no backend', () => {
  const createProduct = functionSource(api, 'createProduct', 'updateProduct')
  assert.match(createProduct, /optionalUuid\(body\.category_id/)
  assert.match(app, /<Field label="Categoria" optional>/)
  assert.match(app, /<option value="">Sem categoria<\/option>/)
})

test('permissões de colaborador são verificadas no servidor', () => {
  assert.match(api, /requirePermission\(user, PERMISSIONS\.CREATE_PRODUCTS/)
  assert.match(api, /PERMISSIONS\.STOCK_ENTRY/)
  assert.match(api, /PERMISSIONS\.STOCK_EXIT/)
  assert.match(api, /requireAdmin\(user\)/)
})

test('dependências antigas e vulneráveis foram removidas', () => {
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies }
  assert.equal(dependencies['@vercel/postgres'], undefined)
  assert.equal(dependencies.xlsx, undefined)
  assert.equal(dependencies.pg, '8.23.1')
})

test('identidade visual oficial está declarada no CSS', () => {
  const css = read('src/index.css').toLowerCase()
  for (const color of ['#ffffff', '#5a3a86', '#fbd532', '#e36781', '#9abbce', '#9663a5']) {
    assert.match(css, new RegExp(color.replace('#', '\\#')))
  }
})
