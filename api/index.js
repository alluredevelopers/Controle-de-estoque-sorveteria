import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import {
  COLLABORATOR_PERMISSION_OPTIONS,
  PERMISSIONS,
} from './lib/constants.js'
import { ensureDatabase, query, withTransaction } from './lib/db.js'
import {
  HttpError,
  booleanValue,
  hasPermission,
  nonNegativeDecimal,
  nonNegativeMoney,
  normalizeLogin,
  normalizePermissions,
  normalizeUnit,
  optionalEmail,
  optionalText,
  optionalUuid,
  parseDate,
  parsePagination,
  positiveDecimal,
  requireAdmin,
  requirePermission,
  requiredText,
  stockStatus,
  text,
  uuid,
  validatePassword,
  validateThresholds,
} from './lib/validation.js'
import {
  assertSameOrigin,
  clearSessionCookie,
  clientIp,
  createSessionToken,
  randomCredential,
  randomLogin,
  sessionTokenFromRequest,
  setSessionCookie,
  sha256,
  verifySessionToken,
} from './lib/security.js'

const MAX_BODY_BYTES = 250_000
let dummyPasswordHashPromise

function setBaseHeaders(res) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
}

function json(res, status, data) {
  setBaseHeaders(res)
  res.status(status)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(data))
}

function noContent(res) {
  setBaseHeaders(res)
  res.status(204).end()
}

async function parseBody(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return {}
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body
  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
    const supplied = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body
    if (Buffer.byteLength(supplied, 'utf8') > MAX_BODY_BYTES) throw new HttpError(413, 'Requisição muito grande.')
    if (!supplied) return {}
    try {
      return JSON.parse(supplied)
    } catch {
      throw new HttpError(400, 'O corpo da requisição contém JSON inválido.')
    }
  }
  const raw = await new Promise((resolve, reject) => {
    let data = ''
    let settled = false
    req.on('data', chunk => {
      if (settled) return
      data += chunk
      if (Buffer.byteLength(data, 'utf8') > MAX_BODY_BYTES) {
        settled = true
        reject(new HttpError(413, 'Requisição muito grande.'))
      }
    })
    req.on('end', () => {
      if (!settled) resolve(data)
    })
    req.on('error', reject)
  })
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'O corpo da requisição contém JSON inválido.')
  }
}

function routePath(req) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const rewrittenRoute = url.searchParams.get('route')
  const path = rewrittenRoute
    ? `/${rewrittenRoute.replace(/^\/+/, '')}`
    : (url.pathname.replace(/^\/api/, '') || '/')
  return { url, path: path.replace(/\/+$/, '') || '/' }
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    login: user.login,
    email: user.email,
    role: user.role,
    permissions: user.permissions || {},
    active: user.active,
    must_change_password: user.must_change_password,
    last_login_at: user.last_login_at,
  }
}

async function currentUser(req) {
  const token = sessionTokenFromRequest(req)
  if (!token) return null

  let payload
  try {
    payload = verifySessionToken(token)
    uuid(payload.id, 'Sessão')
  } catch {
    return null
  }

  const result = await query(
    `SELECT id,name,login,email,role,permissions,active,must_change_password,session_version,last_login_at
     FROM users WHERE id=$1`,
    [payload.id],
  )
  const user = result.rows[0]
  if (!user?.active || Number(user.session_version) !== Number(payload.sv)) return null
  return user
}

async function audit(client, user, action, entityType, entityId, details = {}) {
  await client.query(
    `INSERT INTO audit_logs (action,entity_type,entity_id,actor_id,actor_name,details)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [action, entityType, entityId ? String(entityId) : null, user?.id || null, user?.name || 'Sistema', JSON.stringify(details)],
  )
}

function hasOperationalAccess(user) {
  return user?.role === 'admin'
    || hasPermission(user, PERMISSIONS.CREATE_PRODUCTS)
    || hasPermission(user, PERMISSIONS.STOCK_ENTRY)
    || hasPermission(user, PERMISSIONS.STOCK_EXIT)
}

function requireOperationalAccess(user) {
  if (!hasOperationalAccess(user)) throw new HttpError(403, 'Nenhuma função operacional foi atribuída ao seu acesso.')
}

function configuredSecretIsValid(environmentVariable, provided, { minimumLength = 16 } = {}) {
  const expected = process.env[environmentVariable]
  if (!environmentSecretIsConfigured(environmentVariable, minimumLength)) {
    throw new Error(`${environmentVariable} deve ser configurada com pelo menos ${minimumLength} caracteres.`)
  }
  const left = Buffer.from(text(provided))
  const right = Buffer.from(expected)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function environmentSecretIsConfigured(environmentVariable, minimumLength) {
  const value = process.env[environmentVariable]
  return Boolean(
    value
    && value.length >= minimumLength
    && !/(substitua|change[-_ ]?me|placeholder|exemplo|example)/i.test(value),
  )
}

function setupSecretIsValid(provided) {
  return configuredSecretIsValid('ADMIN_SETUP_SECRET', provided, { minimumLength: 16 })
}

function recoverySecretIsValid(provided) {
  return configuredSecretIsValid('ADMIN_RECOVERY_SECRET', provided, { minimumLength: 24 })
}

async function checkLoginLimit(keyHash) {
  const result = await query('SELECT attempts,locked_until FROM login_attempts WHERE key_hash=$1', [keyHash])
  const row = result.rows[0]
  if (row?.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
    const seconds = Math.max(1, Math.ceil((new Date(row.locked_until).getTime() - Date.now()) / 1000))
    throw new HttpError(429, `Muitas tentativas de acesso. Tente novamente em ${Math.ceil(seconds / 60)} minuto(s).`)
  }
}

async function recordLoginFailure(keyHash) {
  await withTransaction(async client => {
    await client.query(`DELETE FROM login_attempts WHERE last_attempt_at < NOW() - INTERVAL '24 hours'`)
    const result = await client.query('SELECT attempts,last_attempt_at FROM login_attempts WHERE key_hash=$1 FOR UPDATE', [keyHash])
    const row = result.rows[0]
    const stale = !row || Date.now() - new Date(row.last_attempt_at).getTime() > 30 * 60 * 1000
    const attempts = stale ? 1 : Number(row.attempts) + 1
    const lockedUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null
    await client.query(
      `INSERT INTO login_attempts (key_hash,attempts,last_attempt_at,locked_until)
       VALUES ($1,$2,NOW(),$3)
       ON CONFLICT (key_hash) DO UPDATE
       SET attempts=EXCLUDED.attempts,last_attempt_at=NOW(),locked_until=EXCLUDED.locked_until`,
      [keyHash, attempts, lockedUntil],
    )
  })
}

async function clearLoginFailures(keyHash) {
  await query('DELETE FROM login_attempts WHERE key_hash=$1', [keyHash])
}

async function dummyPasswordHash() {
  if (!dummyPasswordHashPromise) {
    dummyPasswordHashPromise = bcrypt.hash('SenhaInvalidaPinguins2026', 12)
  }
  return dummyPasswordHashPromise
}

function buildProductFilters(url, user, { forceActive = false } = {}) {
  const values = []
  const conditions = []
  const activeFilter = forceActive || user.role !== 'admin' ? 'true' : text(url.searchParams.get('active') || 'true')
  if (activeFilter === 'true') conditions.push('p.active=TRUE')
  else if (activeFilter === 'false') conditions.push('p.active=FALSE')
  else if (activeFilter !== 'all') throw new HttpError(400, 'Filtro de situação do produto inválido.')
  const add = value => {
    values.push(value)
    return `$${values.length}`
  }
  const search = text(url.searchParams.get('q'))
  if (search) conditions.push(`LOWER(unaccent(p.name)) LIKE LOWER(unaccent(${add(`%${search}%`)}))`)

  const categoryId = text(url.searchParams.get('category_id'))
  if (categoryId === 'none') conditions.push('p.category_id IS NULL')
  else if (categoryId) conditions.push(`p.category_id=${add(uuid(categoryId, 'Categoria'))}`)

  const minQuantityRaw = text(url.searchParams.get('min_quantity'))
  const maxQuantityRaw = text(url.searchParams.get('max_quantity'))
  const minQuantity = minQuantityRaw ? nonNegativeDecimal(minQuantityRaw, 'Quantidade mínima') : null
  const maxQuantity = maxQuantityRaw ? nonNegativeDecimal(maxQuantityRaw, 'Quantidade máxima') : null
  if (minQuantity !== null && maxQuantity !== null && Number(minQuantity) > Number(maxQuantity)) {
    throw new HttpError(400, 'A quantidade mínima não pode ser maior que a quantidade máxima.')
  }
  if (minQuantity !== null) conditions.push(`p.quantity >= ${add(minQuantity)}::numeric`)
  if (maxQuantity !== null) conditions.push(`p.quantity <= ${add(maxQuantity)}::numeric`)

  const status = text(url.searchParams.get('status'))
  if (status && !['critical', 'low', 'good'].includes(status)) throw new HttpError(400, 'Status de estoque inválido.')
  const statusExpression = `CASE
    WHEN p.quantity <= p.critical_stock THEN 'critical'
    WHEN p.quantity <= p.low_stock THEN 'low'
    ELSE 'good'
  END`
  if (status) conditions.push(`${statusExpression}=${add(status)}`)

  return { values, conditions, statusExpression }
}

async function listProducts(url, user, { optionsOnly = false, exportAll = false } = {}) {
  requireOperationalAccess(user)
  const paginationConfig = optionsOnly ? { defaultSize: 20, maxSize: 30 } : {}
  const { page, pageSize, offset } = parsePagination(url, paginationConfig)
  const { values, conditions, statusExpression } = buildProductFilters(url, user, { forceActive: optionsOnly })
  const filterValues = [...values]
  const where = conditions.length ? conditions.join(' AND ') : 'TRUE'

  let limitClause
  if (exportAll) {
    values.push(50_000)
    limitClause = `LIMIT $${values.length}`
  } else {
    values.push(pageSize, offset)
    limitClause = `LIMIT $${values.length - 1} OFFSET $${values.length}`
  }

  const result = await query(
    `SELECT p.id,p.name,p.category_id,c.name AS category,p.unit,p.quantity,p.active,
            p.critical_stock,p.low_stock,p.cost,p.price,p.created_at,p.updated_at,
            (p.quantity*p.cost) AS inventory_value,
            ${statusExpression} AS status,
            COUNT(*) OVER()::int AS total_count
     FROM products p
     LEFT JOIN categories c ON c.id=p.category_id
     WHERE ${where}
     ORDER BY LOWER(p.name),p.id
     ${limitClause}`,
    values,
  )

  let total = result.rows[0]?.total_count
  if (total === undefined) {
    const countResult = await query(`SELECT COUNT(*)::int AS total FROM products p WHERE ${where}`, filterValues)
    total = countResult.rows[0].total
  }
  const rows = result.rows.map(({ total_count: _total, ...row }) => {
    if (user.role === 'admin') return row
    return {
      id: row.id,
      name: row.name,
      category_id: row.category_id,
      category: row.category,
      unit: row.unit,
      quantity: row.quantity,
      active: row.active,
      status: row.status,
    }
  })

  return {
    rows,
    pagination: {
      page: exportAll ? 1 : page,
      page_size: exportAll ? rows.length : pageSize,
      total,
      pages: exportAll ? 1 : Math.max(1, Math.ceil(total / pageSize)),
      truncated: exportAll && total > rows.length,
    },
  }
}

async function createProduct(body, user, res) {
  requirePermission(user, PERMISSIONS.CREATE_PRODUCTS, 'Seu acesso não permite cadastrar produtos.')
  const name = requiredText(body.name, 'Produto')
  const categoryId = optionalUuid(body.category_id, 'Categoria')
  const unit = normalizeUnit(body.unit)
  let criticalStock = 0
  let lowStock = 0
  let cost = 0
  let price = 0
  if (user.role === 'admin') {
    ;({ criticalStock, lowStock } = validateThresholds(body.critical_stock, body.low_stock))
    cost = nonNegativeMoney(body.cost, 'Custo')
    price = nonNegativeMoney(body.price, 'Preço')
  }

  const product = await withTransaction(async client => {
    if (categoryId) {
      const category = await client.query('SELECT id FROM categories WHERE id=$1', [categoryId])
      if (!category.rowCount) throw new HttpError(400, 'A categoria selecionada não existe.')
    }
    const result = await client.query(
      `INSERT INTO products
       (name,category_id,unit,quantity,min_stock,critical_stock,low_stock,cost,price,created_by,updated_by)
       VALUES ($1,$2,$3,0,$4,$4,$5,$6,$7,$8,$8)
       RETURNING id,name,category_id,unit,quantity,critical_stock,low_stock,cost,price,created_at`,
      [name, categoryId, unit, criticalStock, lowStock, cost, price, user.id],
    )
    await audit(client, user, 'product.created', 'product', result.rows[0].id, { name, unit, category_id: categoryId })
    return result.rows[0]
  })
  return json(res, 201, { product })
}

async function updateProduct(id, body, user, res) {
  requireAdmin(user)
  const productId = uuid(id, 'Produto')
  const name = requiredText(body.name, 'Produto')
  const categoryId = optionalUuid(body.category_id, 'Categoria')
  const unit = normalizeUnit(body.unit)
  const { criticalStock, lowStock } = validateThresholds(body.critical_stock, body.low_stock)
  const cost = nonNegativeMoney(body.cost, 'Custo')
  const price = nonNegativeMoney(body.price, 'Preço')

  const product = await withTransaction(async client => {
    if (categoryId) {
      const category = await client.query('SELECT id FROM categories WHERE id=$1', [categoryId])
      if (!category.rowCount) throw new HttpError(400, 'A categoria selecionada não existe.')
    }
    const result = await client.query(
      `UPDATE products SET name=$1,category_id=$2,unit=$3,min_stock=$4,critical_stock=$4,low_stock=$5,
       cost=$6,price=$7,updated_by=$8,updated_at=NOW()
       WHERE id=$9 AND active=TRUE
       RETURNING id,name,category_id,unit,quantity,critical_stock,low_stock,cost,price,updated_at`,
      [name, categoryId, unit, criticalStock, lowStock, cost, price, user.id, productId],
    )
    if (!result.rowCount) throw new HttpError(404, 'Produto não encontrado.')
    await audit(client, user, 'product.updated', 'product', productId, { name, unit, category_id: categoryId, critical_stock: criticalStock, low_stock: lowStock, cost, price })
    return result.rows[0]
  })
  return json(res, 200, { product })
}

async function findIdempotentMovement(idempotencyKey, client = { query }) {
  const existing = await client.query(
    'SELECT id,created_at FROM stock_movements WHERE idempotency_key=$1',
    [idempotencyKey],
  )
  return existing.rows[0] || null
}

async function updateProductBalance(client, { productId, type, quantity, userId }) {
  if (type === 'entrada') {
    const result = await client.query(
      `UPDATE products
       SET quantity=quantity+$1::numeric,updated_by=$2,updated_at=NOW()
       WHERE id=$3 AND active=TRUE
       RETURNING (quantity-$1::numeric)::text AS balance_before,quantity::text AS balance_after`,
      [quantity, userId, productId],
    )
    return result.rows[0] || null
  }
  const result = await client.query(
    `UPDATE products
     SET quantity=quantity-$1::numeric,updated_by=$2,updated_at=NOW()
     WHERE id=$3 AND active=TRUE AND quantity >= $1::numeric
     RETURNING (quantity+$1::numeric)::text AS balance_before,quantity::text AS balance_after`,
    [quantity, userId, productId],
  )
  return result.rows[0] || null
}

async function createMovement(body, user, res) {
  const productId = uuid(body.product_id, 'Produto')
  const type = text(body.type)
  if (!['entrada', 'saida'].includes(type)) throw new HttpError(400, 'Tipo de movimentação inválido.')
  requirePermission(
    user,
    type === 'entrada' ? PERMISSIONS.STOCK_ENTRY : PERMISSIONS.STOCK_EXIT,
    `Seu acesso não permite registrar ${type === 'entrada' ? 'entradas' : 'saídas'}.`,
  )
  const quantity = positiveDecimal(body.quantity, 'Quantidade')
  const note = optionalText(body.note, 500)
  const idempotencyKey = uuid(body.idempotency_key, 'Chave da movimentação')

  try {
    const movement = await withTransaction(async client => {
      const existing = await findIdempotentMovement(idempotencyKey, client)
      if (existing) return { ...existing, duplicate: true }

      const productResult = await client.query(
        `SELECT p.id,p.name,p.unit,p.active,c.name AS category
         FROM products p LEFT JOIN categories c ON c.id=p.category_id
         WHERE p.id=$1 FOR UPDATE OF p`,
        [productId],
      )
      const product = productResult.rows[0]
      if (!product?.active) throw new HttpError(404, 'Produto não encontrado ou inativo.')

      const balance = await updateProductBalance(client, { productId, type, quantity, userId: user.id })
      if (!balance && type === 'saida') throw new HttpError(409, 'A saída é maior que o estoque disponível.')
      if (!balance) throw new HttpError(404, 'Produto não encontrado ou inativo.')

      const result = await client.query(
        `INSERT INTO stock_movements
         (product_id,product_name_snapshot,category_snapshot,unit_snapshot,type,origin,quantity,balance_before,balance_after,note,idempotency_key,created_by,created_by_name,created_by_role)
         VALUES ($1,$2,$3,$4,$5,'manual',$6::numeric,$7::numeric,$8::numeric,$9,$10,$11,$12,$13)
         RETURNING id,created_at`,
        [productId, product.name, product.category, product.unit, type, quantity, balance.balance_before, balance.balance_after, note, idempotencyKey, user.id, user.name, user.role],
      )
      return { ...result.rows[0], duplicate: false }
    })
    return json(res, movement.duplicate ? 200 : 201, { ok: true, movement })
  } catch (error) {
    if (error?.code === '23505') {
      const existing = await findIdempotentMovement(idempotencyKey)
      if (existing) return json(res, 200, { ok: true, movement: { ...existing, duplicate: true } })
    }
    throw error
  }
}

async function createAdjustment(body, user, res) {
  requireAdmin(user)
  const productId = uuid(body.product_id, 'Produto')
  const targetQuantity = nonNegativeDecimal(body.target_quantity, 'Quantidade correta')
  const reason = requiredText(body.reason, 'Motivo do ajuste', 500)
  const idempotencyKey = uuid(body.idempotency_key, 'Chave do ajuste')

  try {
    const movement = await withTransaction(async client => {
      const existing = await findIdempotentMovement(idempotencyKey, client)
      if (existing) return { ...existing, duplicate: true }
      const productResult = await client.query(
        `SELECT p.id,p.name,p.unit,p.quantity::text AS quantity,p.active,c.name AS category
         FROM products p LEFT JOIN categories c ON c.id=p.category_id
         WHERE p.id=$1 FOR UPDATE OF p`,
        [productId],
      )
      const product = productResult.rows[0]
      if (!product?.active) throw new HttpError(404, 'Produto não encontrado ou inativo.')

      const differenceResult = await client.query(
        `SELECT
           CASE WHEN $1::numeric > $2::numeric THEN 'entrada' ELSE 'saida' END AS type,
           ABS($1::numeric-$2::numeric)::text AS quantity,
           ($1::numeric=$2::numeric) AS unchanged`,
        [targetQuantity, product.quantity],
      )
      const difference = differenceResult.rows[0]
      if (difference.unchanged) throw new HttpError(400, 'A quantidade informada já é o saldo atual.')

      const updated = await client.query(
        `UPDATE products SET quantity=$1::numeric,updated_by=$2,updated_at=NOW()
         WHERE id=$3 AND active=TRUE RETURNING quantity::text AS balance_after`,
        [targetQuantity, user.id, productId],
      )
      if (!updated.rowCount) throw new HttpError(404, 'Produto não encontrado ou inativo.')

      const result = await client.query(
        `INSERT INTO stock_movements
         (product_id,product_name_snapshot,category_snapshot,unit_snapshot,type,origin,quantity,balance_before,balance_after,note,idempotency_key,created_by,created_by_name,created_by_role)
         VALUES ($1,$2,$3,$4,$5,'adjustment',$6::numeric,$7::numeric,$8::numeric,$9,$10,$11,$12,$13)
         RETURNING id,created_at`,
        [productId, product.name, product.category, product.unit, difference.type, difference.quantity, product.quantity, updated.rows[0].balance_after, reason, idempotencyKey, user.id, user.name, user.role],
      )
      await audit(client, user, 'stock.adjusted', 'product', productId, {
        balance_before: product.quantity,
        balance_after: updated.rows[0].balance_after,
        reason,
      })
      return { ...result.rows[0], duplicate: false }
    })
    return json(res, movement.duplicate ? 200 : 201, { ok: true, movement })
  } catch (error) {
    if (error?.code === '23505') {
      const existing = await findIdempotentMovement(idempotencyKey)
      if (existing) return json(res, 200, { ok: true, movement: { ...existing, duplicate: true } })
    }
    throw error
  }
}

async function annulMovement(id, body, user, res) {
  requireAdmin(user)
  const movementId = uuid(id, 'Movimentação')
  const reason = requiredText(body.reason, 'Motivo da anulação', 500)

  const result = await withTransaction(async client => {
    const movementResult = await client.query('SELECT * FROM stock_movements WHERE id=$1 FOR UPDATE', [movementId])
    const movement = movementResult.rows[0]
    if (!movement) throw new HttpError(404, 'Movimentação não encontrada.')
    if (movement.status === 'annulled') throw new HttpError(409, 'Esta movimentação já foi anulada.')
    if (movement.origin === 'annulment') throw new HttpError(409, 'Uma movimentação de reversão não pode ser anulada diretamente.')

    const productResult = await client.query('SELECT id,active FROM products WHERE id=$1 FOR UPDATE', [movement.product_id])
    const product = productResult.rows[0]
    if (!product) throw new HttpError(409, 'O produto relacionado não existe mais.')
    if (!product.active) throw new HttpError(409, 'Reative o produto antes de anular esta movimentação.')
    const reverseType = movement.type === 'entrada' ? 'saida' : 'entrada'
    const balance = await updateProductBalance(client, {
      productId: movement.product_id,
      type: reverseType,
      quantity: String(movement.quantity),
      userId: user.id,
    })
    if (!balance && reverseType === 'saida') {
      throw new HttpError(409, 'Não é possível anular esta entrada porque o estoque atual é insuficiente. Faça primeiro um ajuste administrativo.')
    }
    if (!balance) throw new HttpError(409, 'Não foi possível atualizar o produto relacionado.')

    const reversal = await client.query(
      `INSERT INTO stock_movements
       (product_id,product_name_snapshot,category_snapshot,unit_snapshot,type,origin,quantity,balance_before,balance_after,note,idempotency_key,reversal_of,created_by,created_by_name,created_by_role)
       VALUES ($1,$2,$3,$4,$5,'annulment',$6::numeric,$7::numeric,$8::numeric,$9,$10,$11,$12,$13,$14)
       RETURNING id,created_at`,
      [movement.product_id, movement.product_name_snapshot, movement.category_snapshot, movement.unit_snapshot, reverseType, String(movement.quantity), balance.balance_before, balance.balance_after, `Reversão da movimentação ${movement.id}. Motivo: ${reason}`, crypto.randomUUID(), movement.id, user.id, user.name, user.role],
    )
    await client.query(
      `UPDATE stock_movements SET status='annulled',annulled_by=$1,annulled_by_name=$2,annulled_at=NOW(),annulment_reason=$3,reversal_movement_id=$4 WHERE id=$5`,
      [user.id, user.name, reason, reversal.rows[0].id, movement.id],
    )
    await audit(client, user, 'movement.annulled', 'movement', movement.id, { reason, reversal_movement_id: reversal.rows[0].id })
    return reversal.rows[0]
  })
  return json(res, 200, { ok: true, reversal: result })
}

function buildMovementFilters(url, user) {
  const values = []
  const conditions = []
  const add = value => {
    values.push(value)
    return `$${values.length}`
  }

  if (user.role !== 'admin') conditions.push(`m.created_by=${add(user.id)}`)
  const search = text(url.searchParams.get('q'))
  if (search) conditions.push(`LOWER(unaccent(m.product_name_snapshot)) LIKE LOWER(unaccent(${add(`%${search}%`)}))`)
  const productId = text(url.searchParams.get('product_id'))
  if (productId) conditions.push(`m.product_id=${add(uuid(productId, 'Produto'))}`)
  const category = text(url.searchParams.get('category'))
  if (category === 'none') conditions.push(`(m.category_snapshot IS NULL OR BTRIM(m.category_snapshot)='')`)
  else if (category) conditions.push(`LOWER(unaccent(m.category_snapshot))=LOWER(unaccent(${add(category)}))`)
  const type = text(url.searchParams.get('type'))
  if (type) {
    if (!['entrada', 'saida'].includes(type)) throw new HttpError(400, 'Tipo de movimentação inválido.')
    conditions.push(`m.type=${add(type)}`)
  }
  const status = text(url.searchParams.get('status'))
  if (status) {
    if (!['active', 'annulled'].includes(status)) throw new HttpError(400, 'Status da movimentação inválido.')
    conditions.push(`m.status=${add(status)}`)
  }
  const origin = text(url.searchParams.get('origin'))
  if (origin) {
    if (!['manual', 'adjustment', 'annulment'].includes(origin)) throw new HttpError(400, 'Origem da movimentação inválida.')
    conditions.push(`m.origin=${add(origin)}`)
  }
  const dateFrom = parseDate(url.searchParams.get('date_from'), 'Data inicial')
  const dateTo = parseDate(url.searchParams.get('date_to'), 'Data final', { endOfDay: true })
  if (dateFrom && dateTo && new Date(dateFrom).getTime() > new Date(dateTo).getTime()) {
    throw new HttpError(400, 'A data inicial não pode ser posterior à data final.')
  }
  if (dateFrom) conditions.push(`m.created_at >= ${add(dateFrom)}`)
  if (dateTo) conditions.push(`m.created_at <= ${add(dateTo)}`)
  const minQuantityRaw = text(url.searchParams.get('min_quantity'))
  const maxQuantityRaw = text(url.searchParams.get('max_quantity'))
  const minQuantity = minQuantityRaw ? nonNegativeDecimal(minQuantityRaw, 'Quantidade mínima') : null
  const maxQuantity = maxQuantityRaw ? nonNegativeDecimal(maxQuantityRaw, 'Quantidade máxima') : null
  if (minQuantity !== null && maxQuantity !== null && Number(minQuantity) > Number(maxQuantity)) {
    throw new HttpError(400, 'A quantidade mínima não pode ser maior que a quantidade máxima.')
  }
  if (minQuantity !== null) conditions.push(`m.quantity >= ${add(minQuantity)}::numeric`)
  if (maxQuantity !== null) conditions.push(`m.quantity <= ${add(maxQuantity)}::numeric`)
  const userId = text(url.searchParams.get('user_id'))
  if (userId && user.role === 'admin') conditions.push(`m.created_by=${add(uuid(userId, 'Responsável'))}`)

  return { values, conditions }
}

async function listMovements(url, user, { exportAll = false } = {}) {
  if (user.role !== 'admin' && !hasPermission(user, PERMISSIONS.STOCK_ENTRY) && !hasPermission(user, PERMISSIONS.STOCK_EXIT)) {
    throw new HttpError(403, 'Seu acesso não permite consultar movimentações.')
  }
  const paginationConfig = user.role === 'admin' ? {} : { defaultSize: 20, maxSize: 50 }
  const { page, pageSize, offset } = parsePagination(url, paginationConfig)
  const { values, conditions } = buildMovementFilters(url, user)
  const filterValues = [...values]
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  let limitClause
  if (exportAll) {
    values.push(50_000)
    limitClause = `LIMIT $${values.length}`
  } else {
    values.push(pageSize, offset)
    limitClause = `LIMIT $${values.length - 1} OFFSET $${values.length}`
  }

  const result = await query(
    `SELECT m.id,m.product_id,m.product_name_snapshot AS product_name,m.category_snapshot AS category,
            m.unit_snapshot AS unit,m.type,m.origin,m.quantity,m.balance_before,m.balance_after,m.note,
            m.status,m.created_by,m.created_by_name,m.created_by_role,m.created_at,
            m.annulled_by_name,m.annulled_at,m.annulment_reason,m.reversal_of,m.reversal_movement_id,
            COUNT(*) OVER()::int AS total_count
     FROM stock_movements m
     ${where}
     ORDER BY m.created_at DESC,m.id DESC
     ${limitClause}`,
    values,
  )
  let total = result.rows[0]?.total_count
  if (total === undefined) {
    const countResult = await query(`SELECT COUNT(*)::int AS total FROM stock_movements m ${where}`, filterValues)
    total = countResult.rows[0].total
  }
  const rows = result.rows.map(({ total_count: _total, ...row }) => row)
  return {
    rows,
    pagination: {
      page: exportAll ? 1 : page,
      page_size: exportAll ? rows.length : pageSize,
      total,
      pages: exportAll ? 1 : Math.max(1, Math.ceil(total / pageSize)),
      truncated: exportAll && total > rows.length,
    },
  }
}

function csvValue(value) {
  if (value === null || value === undefined) return ''
  let textValue = String(value)
  if (/^\s*[=+\-@]/.test(textValue) || /^[\t\r]/.test(textValue)) textValue = `'${textValue}`
  return /[";\n\r]/.test(textValue) ? `"${textValue.replaceAll('"', '""')}"` : textValue
}

function sendCsv(res, filename, headers, rows) {
  const lines = [headers.map(csvValue).join(';'), ...rows.map(row => row.map(csvValue).join(';'))]
  const content = `\uFEFF${lines.join('\r\n')}`
  setBaseHeaders(res)
  res.status(200)
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.end(content)
}

async function route(req, res) {
  setBaseHeaders(res)
  if (req.method === 'OPTIONS') return noContent(res)
  assertSameOrigin(req)
  await ensureDatabase()
  const { url, path } = routePath(req)
  const body = await parseBody(req)

  if (path === '/health' && req.method === 'GET') return json(res, 200, { ok: true })

  if (path === '/setup-status' && req.method === 'GET') {
    const result = await query(`SELECT COUNT(*)::int AS count FROM users WHERE role='admin'`)
    return json(res, 200, {
      has_admin: result.rows[0].count > 0,
      setup_enabled: environmentSecretIsConfigured('ADMIN_SETUP_SECRET', 16),
      recovery_enabled: environmentSecretIsConfigured('ADMIN_RECOVERY_SECRET', 24),
    })
  }

  if (path === '/setup-admin' && req.method === 'POST') {
    const existingAdmin = await query(`SELECT 1 FROM users WHERE role='admin' LIMIT 1`)
    if (existingAdmin.rowCount) throw new HttpError(409, 'O administrador inicial já foi criado.')
    const setupRateLimitKey = sha256(`admin-setup|${clientIp(req)}`)
    await checkLoginLimit(setupRateLimitKey)
    if (!setupSecretIsValid(body.setup_secret)) {
      await recordLoginFailure(setupRateLimitKey)
      throw new HttpError(403, 'Chave de instalação inválida.')
    }
    const name = requiredText(body.name, 'Nome')
    const login = normalizeLogin(body.login)
    const email = optionalEmail(body.email)
    const password = validatePassword(body.password)
    const created = await withTransaction(async client => {
      await client.query('LOCK TABLE users IN EXCLUSIVE MODE')
      const count = await client.query(`SELECT COUNT(*)::int AS count FROM users WHERE role='admin'`)
      if (count.rows[0].count > 0) throw new HttpError(409, 'O administrador inicial já foi criado.')
      const passwordHash = await bcrypt.hash(password, 12)
      const result = await client.query(
        `INSERT INTO users (name,login,email,access_code,password_hash,role,permissions)
         VALUES ($1,$2,$3,$2,$4,'admin','{"*":true}'::jsonb)
         RETURNING id,name,login,email,role,permissions,active,must_change_password,session_version,last_login_at`,
        [name, login, email, passwordHash],
      )
      await audit(client, result.rows[0], 'admin.created', 'user', result.rows[0].id, { login })
      return result.rows[0]
    })
    await clearLoginFailures(setupRateLimitKey)
    setSessionCookie(res, createSessionToken(created))
    return json(res, 201, { user: publicUser(created), permission_options: COLLABORATOR_PERMISSION_OPTIONS })
  }

  if (path === '/login' && req.method === 'POST') {
    const login = requiredText(body.login, 'Login', 254).toLowerCase()
    const password = requiredText(body.password, 'Senha', 200)
    const keyHash = sha256(`${login}|${clientIp(req)}`)
    await checkLoginLimit(keyHash)
    const result = await query(
      `SELECT id,name,login,email,access_code,password_hash,role,permissions,active,must_change_password,session_version,last_login_at
       FROM users
       WHERE active=TRUE AND LOWER(login)=$1
       LIMIT 1`,
      [login],
    )
    const user = result.rows[0]
    const passwordHash = user?.password_hash || await dummyPasswordHash()
    const validPassword = await bcrypt.compare(password, passwordHash)
    if (!user || !validPassword) {
      await recordLoginFailure(keyHash)
      throw new HttpError(401, 'Login ou senha inválidos.')
    }
    await clearLoginFailures(keyHash)
    const updated = await query(
      `UPDATE users SET last_login_at=NOW(),updated_at=NOW() WHERE id=$1
       RETURNING id,name,login,email,role,permissions,active,must_change_password,session_version,last_login_at`,
      [user.id],
    )
    setSessionCookie(res, createSessionToken(updated.rows[0]))
    return json(res, 200, { user: publicUser(updated.rows[0]), permission_options: COLLABORATOR_PERMISSION_OPTIONS })
  }

  if (path === '/recover-admin' && req.method === 'POST') {
    const rateLimitKey = sha256(`admin-recovery|${clientIp(req)}`)
    await checkLoginLimit(rateLimitKey)
    if (!recoverySecretIsValid(body.recovery_secret)) {
      await recordLoginFailure(rateLimitKey)
      throw new HttpError(403, 'Os dados de recuperação são inválidos.')
    }
    const login = normalizeLogin(body.login)
    const newPassword = validatePassword(body.new_password)
    let recovered
    try {
      recovered = await withTransaction(async client => {
        const adminResult = await client.query(
        `SELECT id,name,login,email,role,permissions,active,must_change_password,session_version,last_login_at
         FROM users WHERE role='admin' AND LOWER(login)=LOWER($1) FOR UPDATE`,
        [login],
      )
      const admin = adminResult.rows[0]
      if (!admin) throw new HttpError(403, 'Os dados de recuperação são inválidos.')
      const passwordHash = await bcrypt.hash(newPassword, 12)
      const result = await client.query(
        `UPDATE users
         SET password_hash=$1,active=TRUE,must_change_password=FALSE,
             session_version=session_version+1,updated_at=NOW()
         WHERE id=$2
         RETURNING id,name,login,email,role,permissions,active,must_change_password,session_version,last_login_at`,
        [passwordHash, admin.id],
      )
        await audit(client, null, 'admin.recovered', 'user', admin.id, { login: admin.login, ip_hash: sha256(clientIp(req)) })
        return result.rows[0]
      })
    } catch (error) {
      if (error instanceof HttpError && error.status === 403) await recordLoginFailure(rateLimitKey)
      throw error
    }
    await clearLoginFailures(rateLimitKey)
    setSessionCookie(res, createSessionToken(recovered))
    return json(res, 200, { user: publicUser(recovered), permission_options: COLLABORATOR_PERMISSION_OPTIONS })
  }

  if (path === '/logout' && req.method === 'POST') {
    clearSessionCookie(res)
    return json(res, 200, { ok: true })
  }

  const user = await currentUser(req)
  if (!user) {
    clearSessionCookie(res)
    throw new HttpError(401, 'Sua sessão expirou. Entre novamente.')
  }

  if (path === '/me' && req.method === 'GET') {
    return json(res, 200, {
      user: publicUser(user),
      permission_options: COLLABORATOR_PERMISSION_OPTIONS,
    })
  }

  if (path === '/change-password' && req.method === 'POST') {
    const currentPassword = requiredText(body.current_password, 'Senha atual', 200)
    const newPassword = validatePassword(body.new_password)
    const updated = await withTransaction(async client => {
      const passwordResult = await client.query('SELECT password_hash FROM users WHERE id=$1 FOR UPDATE', [user.id])
      if (!(await bcrypt.compare(currentPassword, passwordResult.rows[0].password_hash))) {
        throw new HttpError(400, 'A senha atual está incorreta.')
      }
      if (await bcrypt.compare(newPassword, passwordResult.rows[0].password_hash)) {
        throw new HttpError(400, 'A nova senha precisa ser diferente da senha atual.')
      }
      const hash = await bcrypt.hash(newPassword, 12)
      const result = await client.query(
        `UPDATE users SET password_hash=$1,must_change_password=FALSE,session_version=session_version+1,updated_at=NOW()
         WHERE id=$2
         RETURNING id,name,login,email,role,permissions,active,must_change_password,session_version,last_login_at`,
        [hash, user.id],
      )
      await audit(client, user, 'user.password_changed', 'user', user.id, { login: user.login })
      return result.rows[0]
    })
    setSessionCookie(res, createSessionToken(updated))
    return json(res, 200, { user: publicUser(updated) })
  }

  if (user.must_change_password) {
    throw new HttpError(403, 'Altere sua senha temporária antes de continuar.', 'PASSWORD_CHANGE_REQUIRED')
  }

  if (path === '/categories' && req.method === 'GET') {
    requireOperationalAccess(user)
    const result = await query('SELECT id,name FROM categories ORDER BY LOWER(name)')
    return json(res, 200, { categories: result.rows })
  }

  if (path === '/categories' && req.method === 'POST') {
    requireAdmin(user)
    const name = requiredText(body.name, 'Categoria', 80)
    const result = await withTransaction(async client => {
      const inserted = await client.query(
        `INSERT INTO categories (name) VALUES ($1)
         ON CONFLICT DO NOTHING
         RETURNING id,name`,
        [name],
      )
      if (inserted.rowCount) {
        await audit(client, user, 'category.created', 'category', inserted.rows[0].id, { name })
        return { category: inserted.rows[0], created: true }
      }
      const existing = await client.query(
        `SELECT id,name FROM categories WHERE LOWER(BTRIM(name))=LOWER(BTRIM($1)) LIMIT 1`,
        [name],
      )
      if (!existing.rowCount) throw new HttpError(409, 'Não foi possível cadastrar a categoria porque já existe um registro conflitante.')
      return { category: existing.rows[0], created: false }
    })
    return json(res, result.created ? 201 : 200, result)
  }

  const categoryMatch = path.match(/^\/categories\/([0-9a-f-]+)$/i)
  if (categoryMatch && req.method === 'DELETE') {
    requireAdmin(user)
    const categoryId = uuid(categoryMatch[1], 'Categoria')
    await withTransaction(async client => {
      await client.query('UPDATE products SET category_id=NULL,updated_by=$1,updated_at=NOW() WHERE category_id=$2', [user.id, categoryId])
      const result = await client.query('DELETE FROM categories WHERE id=$1 RETURNING name', [categoryId])
      if (!result.rowCount) throw new HttpError(404, 'Categoria não encontrada.')
      await audit(client, user, 'category.deleted', 'category', categoryId, { name: result.rows[0].name })
    })
    return json(res, 200, { ok: true })
  }

  if (path === '/dashboard' && req.method === 'GET') {
    requireAdmin(user)
    const result = await query(`
      SELECT
        COUNT(*)::int AS products,
        COUNT(*) FILTER (WHERE quantity <= critical_stock)::int AS critical,
        COUNT(*) FILTER (WHERE quantity > critical_stock AND quantity <= low_stock)::int AS low,
        COUNT(*) FILTER (WHERE quantity > low_stock)::int AS good,
        COALESCE(SUM(quantity * cost),0) AS inventory_value
      FROM products WHERE active=TRUE
    `)
    const recent = await query(`
      SELECT id,product_name_snapshot AS product_name,type,origin,quantity,unit_snapshot AS unit,created_by_name,created_at,status
      FROM stock_movements ORDER BY created_at DESC LIMIT 8
    `)
    return json(res, 200, { summary: result.rows[0], recent_movements: recent.rows })
  }

  if (path === '/products/options' && req.method === 'GET') {
    const result = await listProducts(url, user, { optionsOnly: true })
    return json(res, 200, { products: result.rows })
  }

  if (path === '/products' && req.method === 'GET') {
    const result = await listProducts(url, user)
    return json(res, 200, { products: result.rows, pagination: result.pagination })
  }

  if (path === '/products' && req.method === 'POST') return createProduct(body, user, res)

  const productMatch = path.match(/^\/products\/([0-9a-f-]+)$/i)
  if (productMatch && req.method === 'PUT') return updateProduct(productMatch[1], body, user, res)
  if (productMatch && req.method === 'DELETE') {
    requireAdmin(user)
    const productId = uuid(productMatch[1], 'Produto')
    await withTransaction(async client => {
      const productResult = await client.query('SELECT id,name,quantity,active FROM products WHERE id=$1 FOR UPDATE', [productId])
      const product = productResult.rows[0]
      if (!product) throw new HttpError(404, 'Produto não encontrado.')
      if (!product.active) throw new HttpError(409, 'Este produto já está inativo.')
      if (Number(product.quantity) !== 0) {
        throw new HttpError(409, 'O produto só pode ser desativado com saldo zero. Faça um ajuste administrativo antes de continuar.')
      }
      await client.query('UPDATE products SET active=FALSE,updated_by=$1,updated_at=NOW() WHERE id=$2', [user.id, productId])
      await audit(client, user, 'product.deactivated', 'product', productId, { name: product.name })
    })
    return json(res, 200, { ok: true })
  }

  const reactivateMatch = path.match(/^\/products\/([0-9a-f-]+)\/reactivate$/i)
  if (reactivateMatch && req.method === 'POST') {
    requireAdmin(user)
    const productId = uuid(reactivateMatch[1], 'Produto')
    const product = await withTransaction(async client => {
      const result = await client.query(
        `UPDATE products SET active=TRUE,updated_by=$1,updated_at=NOW()
         WHERE id=$2 AND active=FALSE RETURNING id,name,category_id,unit,quantity,critical_stock,low_stock,cost,price,active,updated_at`,
        [user.id, productId],
      )
      if (!result.rowCount) throw new HttpError(404, 'Produto inativo não encontrado.')
      await audit(client, user, 'product.reactivated', 'product', productId, { name: result.rows[0].name })
      return result.rows[0]
    })
    return json(res, 200, { product })
  }

  if (path === '/movements' && req.method === 'GET') {
    const result = await listMovements(url, user)
    return json(res, 200, { movements: result.rows, pagination: result.pagination })
  }
  if (path === '/movements' && req.method === 'POST') return createMovement(body, user, res)
  if (path === '/adjustments' && req.method === 'POST') return createAdjustment(body, user, res)

  const annulMatch = path.match(/^\/movements\/([0-9a-f-]+)\/annul$/i)
  if (annulMatch && req.method === 'POST') return annulMovement(annulMatch[1], body, user, res)

  if (path === '/movement-users' && req.method === 'GET') {
    requireAdmin(user)
    const result = await query(
      `SELECT DISTINCT ON (id) id,name,role
       FROM (
         SELECT id,name,role,active,0 AS source_order FROM users
         UNION ALL
         SELECT created_by AS id,created_by_name AS name,created_by_role AS role,TRUE AS active,1 AS source_order
         FROM stock_movements WHERE created_by IS NOT NULL
       ) people
       WHERE id IS NOT NULL
       ORDER BY id,source_order,LOWER(name)`,
    )
    return json(res, 200, { users: result.rows.sort((left, right) => left.name.localeCompare(right.name, 'pt-BR')) })
  }

  if (path === '/users' && req.method === 'GET') {
    requireAdmin(user)
    const result = await query(
      `SELECT id,name,login,email,role,permissions,active,must_change_password,last_login_at,created_at,updated_at
       FROM users WHERE role='collaborator' ORDER BY active DESC,LOWER(name)`,
    )
    return json(res, 200, { users: result.rows })
  }

  if (path === '/users' && req.method === 'POST') {
    requireAdmin(user)
    const name = requiredText(body.name, 'Nome')
    const login = body.login ? normalizeLogin(body.login) : randomLogin()
    const email = optionalEmail(body.email)
    const generatedPassword = !text(body.password)
    const password = generatedPassword ? `P${randomCredential(10)}7` : validatePassword(body.password, { temporary: true })
    const permissions = normalizePermissions(body.permissions)
    const hash = await bcrypt.hash(password, 12)
    const created = await withTransaction(async client => {
      const result = await client.query(
        `INSERT INTO users
         (name,login,email,access_code,password_hash,role,permissions,active,must_change_password,created_by)
         VALUES ($1,$2,$3,$2,$4,'collaborator',$5::jsonb,TRUE,TRUE,$6)
         RETURNING id,name,login,email,role,permissions,active,must_change_password,last_login_at,created_at`,
        [name, login, email, hash, JSON.stringify(permissions), user.id],
      )
      await audit(client, user, 'user.created', 'user', result.rows[0].id, { login, permissions })
      return result.rows[0]
    })
    return json(res, 201, { user: created, temporary_password: password })
  }

  const resetPasswordMatch = path.match(/^\/users\/([0-9a-f-]+)\/reset-password$/i)
  if (resetPasswordMatch && req.method === 'POST') {
    requireAdmin(user)
    const userId = uuid(resetPasswordMatch[1], 'Colaborador')
    const password = text(body.password) ? validatePassword(body.password, { temporary: true }) : `P${randomCredential(10)}7`
    const hash = await bcrypt.hash(password, 12)
    await withTransaction(async client => {
      const result = await client.query(
        `UPDATE users SET password_hash=$1,must_change_password=TRUE,session_version=session_version+1,updated_at=NOW()
         WHERE id=$2 AND role='collaborator' RETURNING login`,
        [hash, userId],
      )
      if (!result.rowCount) throw new HttpError(404, 'Colaborador não encontrado.')
      await audit(client, user, 'user.password_reset', 'user', userId, { login: result.rows[0].login })
    })
    return json(res, 200, { ok: true, temporary_password: password })
  }

  const userMatch = path.match(/^\/users\/([0-9a-f-]+)$/i)
  if (userMatch && req.method === 'PATCH') {
    requireAdmin(user)
    const userId = uuid(userMatch[1], 'Colaborador')
    const updated = await withTransaction(async client => {
      const current = await client.query(`SELECT * FROM users WHERE id=$1 AND role='collaborator' FOR UPDATE`, [userId])
      if (!current.rowCount) throw new HttpError(404, 'Colaborador não encontrado.')
      const existing = current.rows[0]
      const name = body.name === undefined ? existing.name : requiredText(body.name, 'Nome')
      const login = body.login === undefined ? existing.login : normalizeLogin(body.login)
      const email = body.email === undefined ? existing.email : optionalEmail(body.email)
      const permissions = body.permissions === undefined ? existing.permissions : normalizePermissions(body.permissions)
      const active = body.active === undefined ? existing.active : booleanValue(body.active)
      const result = await client.query(
        `UPDATE users SET name=$1,login=$2,email=$3,access_code=$2,permissions=$4::jsonb,active=$5,
         session_version=session_version+1,updated_at=NOW()
         WHERE id=$6 AND role='collaborator'
         RETURNING id,name,login,email,role,permissions,active,must_change_password,last_login_at,created_at,updated_at`,
        [name, login, email, JSON.stringify(permissions), active, userId],
      )
      await audit(client, user, 'user.updated', 'user', userId, { login, permissions, active })
      return result.rows[0]
    })
    return json(res, 200, { user: updated })
  }

  if (path === '/audit' && req.method === 'GET') {
    requireAdmin(user)
    const { page, pageSize, offset } = parsePagination(url, { defaultSize: 30, maxSize: 100 })
    const result = await query(
      `SELECT id,action,entity_type,entity_id,actor_id,actor_name,details,created_at,COUNT(*) OVER()::int AS total_count
       FROM audit_logs ORDER BY created_at DESC,id DESC LIMIT $1 OFFSET $2`,
      [pageSize, offset],
    )
    let total = result.rows[0]?.total_count
    if (total === undefined) {
      const countResult = await query('SELECT COUNT(*)::int AS total FROM audit_logs')
      total = countResult.rows[0].total
    }
    const logs = result.rows.map(({ total_count: _total, ...row }) => row)
    return json(res, 200, { logs, pagination: { page, page_size: pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) } })
  }

  if (path === '/export/stock.csv' && req.method === 'GET') {
    requireAdmin(user)
    const result = await listProducts(url, user, { exportAll: true })
    if (result.pagination.truncated) throw new HttpError(413, 'O relatório possui mais de 50 mil itens. Refine os filtros antes de exportar.')
    const labels = { critical: 'Crítico', low: 'Baixo', good: 'Bom' }
    return sendCsv(
      res,
      'estoque-pinguins.csv',
      ['Produto', 'Categoria', 'Quantidade', 'Unidade', 'Limite crítico', 'Limite baixo', 'Status', 'Custo', 'Preço', 'Valor em estoque'],
      result.rows.map(row => [row.name, row.category || 'Sem categoria', row.quantity, row.unit, row.critical_stock, row.low_stock, labels[row.status] || row.status, row.cost, row.price, row.inventory_value]),
    )
  }

  if (path === '/export/movements.csv' && req.method === 'GET') {
    requireAdmin(user)
    const result = await listMovements(url, user, { exportAll: true })
    if (result.pagination.truncated) throw new HttpError(413, 'O relatório possui mais de 50 mil movimentações. Refine os filtros antes de exportar.')
    const typeLabels = { entrada: 'Entrada', saida: 'Saída' }
    const originLabels = { manual: 'Manual', adjustment: 'Ajuste', annulment: 'Anulação' }
    const statusLabels = { active: 'Ativa', annulled: 'Anulada' }
    const dateFormatter = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Bahia',
      dateStyle: 'short',
      timeStyle: 'medium',
    })
    return sendCsv(
      res,
      'movimentacoes-pinguins.csv',
      ['Data', 'Produto', 'Categoria', 'Tipo', 'Origem', 'Quantidade', 'Unidade', 'Saldo anterior', 'Saldo posterior', 'Responsável', 'Status', 'Observação'],
      result.rows.map(row => [dateFormatter.format(new Date(row.created_at)), row.product_name, row.category || 'Sem categoria', typeLabels[row.type] || row.type, originLabels[row.origin] || row.origin, row.quantity, row.unit, row.balance_before, row.balance_after, row.created_by_name, statusLabels[row.status] || row.status, row.note || '']),
    )
  }

  throw new HttpError(404, 'Rota não encontrada.')
}

export default async function handler(req, res) {
  try {
    await route(req, res)
  } catch (error) {
    console.error(error)
    if (res.headersSent) return
    if (error?.code === '23505') {
      return json(res, 409, { error: 'Já existe um registro com esse login, e-mail ou nome de produto.', code: 'DUPLICATE' })
    }
    if (error?.code === '23503') {
      return json(res, 400, { error: 'Um dos dados relacionados não existe.', code: 'FOREIGN_KEY' })
    }
    if (error?.code === '23514') {
      return json(res, 400, { error: 'Os valores informados não respeitam as regras do sistema.', code: 'CHECK_CONSTRAINT' })
    }
    return json(res, error.status || 500, {
      error: error.status ? error.message : 'Erro interno. Tente novamente.',
      code: error.code || 'INTERNAL_ERROR',
    })
  }
}

export { stockStatus }
