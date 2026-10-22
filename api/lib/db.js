import pg from 'pg'
import { attachDatabasePool } from '@vercel/functions'
import { DEFAULT_CATEGORIES, PERMISSIONS } from './constants.js'

const { Pool } = pg
let pool
let migrationPromise

function connectionString() {
  const value = process.env.DATABASE_URL || process.env.POSTGRES_URL
  if (!value) throw new Error('DATABASE_URL ou POSTGRES_URL não foi configurada.')
  return value
}

export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: connectionString(),
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      allowExitOnIdle: true,
    })
    attachDatabasePool(pool)
  }
  return pool
}

export function query(text, values = []) {
  return getPool().query(text, values)
}

export async function withTransaction(callback) {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function migration1(client) {
  await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')

  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      login TEXT NOT NULL,
      email TEXT,
      access_code TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','collaborator')),
      permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
      session_version INTEGER NOT NULL DEFAULT 1,
      created_by UUID,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS products (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
      unit TEXT NOT NULL,
      quantity NUMERIC(18,3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
      min_stock NUMERIC(18,3) NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
      critical_stock NUMERIC(18,3) NOT NULL DEFAULT 0 CHECK (critical_stock >= 0),
      low_stock NUMERIC(18,3) NOT NULL DEFAULT 0 CHECK (low_stock >= critical_stock),
      cost NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
      price NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by UUID,
      updated_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS stock_movements (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id UUID REFERENCES products(id),
      product_name_snapshot TEXT NOT NULL,
      category_snapshot TEXT,
      unit_snapshot TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('entrada','saida')),
      origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','adjustment','annulment')),
      quantity NUMERIC(18,3) NOT NULL CHECK (quantity > 0),
      balance_before NUMERIC(18,3),
      balance_after NUMERIC(18,3),
      note TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','annulled')),
      idempotency_key UUID NOT NULL DEFAULT gen_random_uuid(),
      reversal_of UUID REFERENCES stock_movements(id),
      reversal_movement_id UUID REFERENCES stock_movements(id),
      annulled_by UUID,
      annulled_by_name TEXT,
      annulled_at TIMESTAMPTZ,
      annulment_reason TEXT,
      created_by UUID,
      created_by_name TEXT NOT NULL,
      created_by_role TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      actor_id UUID,
      actor_name TEXT NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      key_hash TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      locked_until TIMESTAMPTZ
    )
  `)
}

async function migration2(client) {
  await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS login TEXT`)
  await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'::jsonb`)
  await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE`)
  await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 1`)
  await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ`)
  await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)

  await client.query(`
    UPDATE users
    SET login = LOWER(COALESCE(NULLIF(BTRIM(access_code), ''), NULLIF(BTRIM(email), ''), 'usuario-' || SUBSTR(id::text, 1, 8)))
    WHERE login IS NULL OR BTRIM(login) = ''
  `)
  await client.query(`
    UPDATE users
    SET login = LOWER(REGEXP_REPLACE(login, '[^a-zA-Z0-9._@+-]+', '-', 'g'))
    WHERE POSITION('@' IN login)=0
  `)
  await client.query(`
    UPDATE users
    SET login = 'usuario-' || SUBSTR(id::text, 1, 8)
    WHERE login IS NULL OR BTRIM(login) = ''
  `)
  await client.query(`
    WITH ranked AS (
      SELECT id, login, ROW_NUMBER() OVER (PARTITION BY LOWER(login) ORDER BY created_at, id) AS position
      FROM users
    )
    UPDATE users AS target
    SET login = target.login || '-' || SUBSTR(target.id::text, 1, 4)
    FROM ranked
    WHERE target.id = ranked.id AND ranked.position > 1
  `)
  await client.query(`ALTER TABLE users ALTER COLUMN login SET NOT NULL`)
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_login_unique_ci ON users ((LOWER(login)))`)
  await client.query(`
    WITH ranked AS (
      SELECT id,email,ROW_NUMBER() OVER (PARTITION BY LOWER(email) ORDER BY created_at,id) AS position
      FROM users
      WHERE email IS NOT NULL
    )
    UPDATE users AS target
    SET email=NULL
    FROM ranked
    WHERE target.id=ranked.id AND ranked.position > 1
  `)
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_ci ON users ((LOWER(email))) WHERE email IS NOT NULL`)

  const collaboratorPermissions = JSON.stringify({
    [PERMISSIONS.CREATE_PRODUCTS]: true,
    [PERMISSIONS.STOCK_ENTRY]: true,
    [PERMISSIONS.STOCK_EXIT]: true,
  })
  await client.query(`UPDATE users SET permissions='{"*":true}'::jsonb WHERE role='admin'`)
  await client.query(
    `UPDATE users SET permissions=$1::jsonb WHERE role='collaborator' AND (permissions IS NULL OR permissions='{}'::jsonb)`,
    [collaboratorPermissions],
  )

  await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE`)
  await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS critical_stock NUMERIC(18,3) NOT NULL DEFAULT 0`)
  await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS low_stock NUMERIC(18,3) NOT NULL DEFAULT 0`)
  await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
  await client.query(`
    UPDATE products
    SET low_stock = GREATEST(COALESCE(low_stock, 0), COALESCE(min_stock, 0), COALESCE(critical_stock, 0)),
        critical_stock = GREATEST(0, LEAST(COALESCE(critical_stock, 0), GREATEST(COALESCE(low_stock, 0), COALESCE(min_stock, 0))))
  `)
  await client.query(`
    UPDATE products
    SET critical_stock = ROUND(low_stock / 2.0, 3)
    WHERE critical_stock = 0 AND low_stock > 0
  `)
  await client.query(`
    WITH ranked AS (
      SELECT id, name, ROW_NUMBER() OVER (PARTITION BY LOWER(BTRIM(name)) ORDER BY created_at, id) AS position
      FROM products
      WHERE active = TRUE
    )
    UPDATE products AS target
    SET name = target.name || ' (' || ranked.position || ')'
    FROM ranked
    WHERE target.id = ranked.id AND ranked.position > 1
  `)
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS products_active_name_unique_ci ON products ((LOWER(BTRIM(name)))) WHERE active=TRUE`)

  await client.query(`ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS product_name_snapshot TEXT`)
  await client.query(`ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS category_snapshot TEXT`)
  await client.query(`ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS unit_snapshot TEXT`)
  await client.query(`ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'manual'`)
  await client.query(`ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS balance_before NUMERIC(18,3)`)
  await client.query(`ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS balance_after NUMERIC(18,3)`)
  await client.query(`ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`)
  await client.query(`ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS idempotency_key UUID DEFAULT gen_random_uuid()`)
  await client.query(`ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS reversal_of UUID`)
  await client.query(`ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS reversal_movement_id UUID`)
  await client.query(`ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS annulled_by UUID`)
  await client.query(`ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS annulled_by_name TEXT`)
  await client.query(`ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS annulled_at TIMESTAMPTZ`)
  await client.query(`ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS annulment_reason TEXT`)
  await client.query(`
    UPDATE stock_movements AS movement
    SET product_name_snapshot = COALESCE(movement.product_name_snapshot, product.name, 'Produto não encontrado'),
        category_snapshot = COALESCE(movement.category_snapshot, category.name),
        unit_snapshot = COALESCE(movement.unit_snapshot, product.unit, 'unidade'),
        idempotency_key = COALESCE(movement.idempotency_key, gen_random_uuid())
    FROM products AS product
    LEFT JOIN categories AS category ON category.id = product.category_id
    WHERE movement.product_id = product.id
  `)
  await client.query(`UPDATE stock_movements SET product_name_snapshot='Produto não encontrado' WHERE product_name_snapshot IS NULL`)
  await client.query(`UPDATE stock_movements SET unit_snapshot='unidade' WHERE unit_snapshot IS NULL`)
  await client.query(`UPDATE stock_movements SET idempotency_key=gen_random_uuid() WHERE idempotency_key IS NULL`)
  await client.query(`ALTER TABLE stock_movements ALTER COLUMN product_name_snapshot SET NOT NULL`)
  await client.query(`ALTER TABLE stock_movements ALTER COLUMN unit_snapshot SET NOT NULL`)
  await client.query(`ALTER TABLE stock_movements ALTER COLUMN idempotency_key SET NOT NULL`)
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS stock_movements_idempotency_unique ON stock_movements (idempotency_key)`)
  await client.query(`CREATE INDEX IF NOT EXISTS stock_movements_created_at_idx ON stock_movements (created_at DESC)`)
  await client.query(`CREATE INDEX IF NOT EXISTS stock_movements_product_idx ON stock_movements (product_id, created_at DESC)`)
  await client.query(`CREATE INDEX IF NOT EXISTS products_status_idx ON products (active, quantity, critical_stock, low_stock)`)
}

async function migration3(client) {
  await client.query(`
    WITH ranked AS (
      SELECT id,name,ROW_NUMBER() OVER (PARTITION BY LOWER(BTRIM(name)) ORDER BY created_at,id) AS position
      FROM categories
    )
    UPDATE products AS product
    SET category_id=canonical.id
    FROM categories AS duplicate
    JOIN categories AS canonical ON LOWER(BTRIM(canonical.name))=LOWER(BTRIM(duplicate.name)) AND canonical.id<>duplicate.id
    WHERE product.category_id=duplicate.id
      AND duplicate.id IN (SELECT id FROM ranked WHERE position > 1)
      AND canonical.id IN (SELECT id FROM ranked WHERE position = 1)
  `)
  await client.query(`DELETE FROM categories WHERE id IN (
    SELECT id FROM (
      SELECT id,ROW_NUMBER() OVER (PARTITION BY LOWER(BTRIM(name)) ORDER BY created_at,id) AS position
      FROM categories
    ) ranked WHERE position > 1
  )`)
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS categories_name_unique_ci ON categories ((LOWER(BTRIM(name))))`)

  for (const name of DEFAULT_CATEGORIES) {
    await client.query(`INSERT INTO categories (name) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM categories WHERE LOWER(BTRIM(name))=LOWER(BTRIM($1)))`, [name])
  }

  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='products_thresholds_valid') THEN
        ALTER TABLE products ADD CONSTRAINT products_thresholds_valid CHECK (critical_stock >= 0 AND low_stock >= critical_stock);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='stock_movements_status_valid') THEN
        ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_status_valid CHECK (status IN ('active','annulled'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='stock_movements_origin_valid') THEN
        ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_origin_valid CHECK (origin IN ('manual','adjustment','annulment'));
      END IF;
    END $$
  `)
}


async function migration4(client) {
  await client.query('CREATE EXTENSION IF NOT EXISTS unaccent')
}

async function migration5(client) {
  await client.query(`
    UPDATE users AS account
    SET login=LOWER(BTRIM(account.email))
    WHERE account.role='admin'
      AND account.email IS NOT NULL
      AND LOWER(BTRIM(account.login)) IN (
        LOWER(REGEXP_REPLACE(BTRIM(account.email), '[^a-zA-Z0-9._@-]+', '-', 'g')),
        LOWER(REGEXP_REPLACE(BTRIM(account.email), '[^a-zA-Z0-9._-]+', '-', 'g'))
      )
      AND NOT EXISTS (
        SELECT 1 FROM users AS other
        WHERE other.id<>account.id AND LOWER(other.login)=LOWER(BTRIM(account.email))
      )
  `)
  await client.query(`
    ALTER TABLE products
      ALTER COLUMN quantity TYPE NUMERIC(18,3) USING ROUND(COALESCE(quantity,0)::numeric,3),
      ALTER COLUMN min_stock TYPE NUMERIC(18,3) USING ROUND(COALESCE(min_stock,0)::numeric,3),
      ALTER COLUMN critical_stock TYPE NUMERIC(18,3) USING ROUND(COALESCE(critical_stock,0)::numeric,3),
      ALTER COLUMN low_stock TYPE NUMERIC(18,3) USING ROUND(COALESCE(low_stock,0)::numeric,3),
      ALTER COLUMN cost TYPE NUMERIC(18,2) USING ROUND(COALESCE(cost,0)::numeric,2),
      ALTER COLUMN price TYPE NUMERIC(18,2) USING ROUND(COALESCE(price,0)::numeric,2)
  `)
  await client.query(`
    ALTER TABLE stock_movements
      ALTER COLUMN quantity TYPE NUMERIC(18,3) USING CASE
        WHEN COALESCE(quantity,0)::numeric > 0 AND ROUND(COALESCE(quantity,0)::numeric,3)=0 THEN 0.001
        ELSE ROUND(COALESCE(quantity,0)::numeric,3)
      END,
      ALTER COLUMN balance_before TYPE NUMERIC(18,3) USING CASE WHEN balance_before IS NULL THEN NULL ELSE ROUND(balance_before::numeric,3) END,
      ALTER COLUMN balance_after TYPE NUMERIC(18,3) USING CASE WHEN balance_after IS NULL THEN NULL ELSE ROUND(balance_after::numeric,3) END
  `)
}

async function migration6(client) {
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid='stock_movements'::regclass AND conname='stock_movements_reversal_of_fk'
      ) THEN
        ALTER TABLE stock_movements
          ADD CONSTRAINT stock_movements_reversal_of_fk
          FOREIGN KEY (reversal_of) REFERENCES stock_movements(id) ON DELETE SET NULL;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid='stock_movements'::regclass AND conname='stock_movements_reversal_movement_fk'
      ) THEN
        ALTER TABLE stock_movements
          ADD CONSTRAINT stock_movements_reversal_movement_fk
          FOREIGN KEY (reversal_movement_id) REFERENCES stock_movements(id) ON DELETE SET NULL;
      END IF;
    END $$
  `)
  await client.query('CREATE INDEX IF NOT EXISTS stock_movements_created_by_created_at_idx ON stock_movements (created_by, created_at DESC)')
  await client.query('CREATE INDEX IF NOT EXISTS stock_movements_status_created_at_idx ON stock_movements (status, created_at DESC)')
  await client.query('CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs (created_at DESC)')
  await client.query('CREATE INDEX IF NOT EXISTS login_attempts_last_attempt_idx ON login_attempts (last_attempt_at)')
  await client.query('CREATE INDEX IF NOT EXISTS users_role_active_idx ON users (role, active)')
  await client.query('CREATE INDEX IF NOT EXISTS products_category_active_idx ON products (category_id, active)')
}

async function migration7(client) {
  await client.query(`
    UPDATE users AS account
    SET login=LOWER(BTRIM(account.email)),updated_at=NOW()
    WHERE account.role='admin'
      AND account.email IS NOT NULL
      AND LOWER(BTRIM(account.login)) IN (
        LOWER(REGEXP_REPLACE(BTRIM(account.email), '[^a-zA-Z0-9._@-]+', '-', 'g')),
        LOWER(REGEXP_REPLACE(BTRIM(account.email), '[^a-zA-Z0-9._-]+', '-', 'g'))
      )
      AND NOT EXISTS (
        SELECT 1 FROM users AS other
        WHERE other.id<>account.id AND LOWER(other.login)=LOWER(BTRIM(account.email))
      )
  `)
}

const migrations = [migration1, migration2, migration3, migration4, migration5, migration6, migration7]

async function runMigrations() {
  const client = await getPool().connect()
  const lockId = 2026102101
  try {
    await client.query('SELECT pg_advisory_lock($1)', [lockId])
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    const appliedResult = await client.query('SELECT version FROM schema_migrations')
    const applied = new Set(appliedResult.rows.map(row => Number(row.version)))

    for (let index = 0; index < migrations.length; index += 1) {
      const version = index + 1
      if (applied.has(version)) continue
      await client.query('BEGIN')
      try {
        await migrations[index](client)
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version])
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [lockId])
    } finally {
      client.release()
    }
  }
}

export function ensureDatabase() {
  if (!migrationPromise) {
    migrationPromise = runMigrations().catch(error => {
      migrationPromise = null
      throw error
    })
  }
  return migrationPromise
}
