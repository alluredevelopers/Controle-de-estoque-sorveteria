import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  BarChart3,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Download,
  Edit3,
  Eye,
  EyeOff,
  FileSpreadsheet,
  History,
  KeyRound,
  Layers3,
  LogOut,
  Menu,
  Package,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  UserCog,
  Users,
  X,
} from 'lucide-react'
import { ApiError, api, download, queryString } from './api.js'
import {
  PERMISSIONS,
  UNITS,
  formatDateTime,
  formatMoney,
  formatNumber,
  hasPermission,
  movementOriginLabel,
  movementTypeLabel,
  newIdempotencyKey,
  statusLabel,
} from './utils.js'

const EMPTY_PAGINATION = { page: 1, page_size: 20, total: 0, pages: 1 }

function useDebouncedValue(value, delay = 250) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timeout = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timeout)
  }, [value, delay])
  return debounced
}

export default function App() {
  const [booting, setBooting] = useState(true)
  const [hasAdmin, setHasAdmin] = useState(true)
  const [setupEnabled, setSetupEnabled] = useState(true)
  const [recoveryEnabled, setRecoveryEnabled] = useState(false)
  const [user, setUser] = useState(null)
  const [permissionOptions, setPermissionOptions] = useState([])
  const [page, setPage] = useState('dashboard')
  const [menuOpen, setMenuOpen] = useState(false)
  const [refreshSignal, setRefreshSignal] = useState(Date.now())
  const [notice, setNotice] = useState(null)
  const [showPasswordChange, setShowPasswordChange] = useState(false)
  const sessionEpoch = useRef(0)

  const notify = useCallback((type, message) => {
    setNotice({ type, message, id: Date.now() })
  }, [])

  const handleError = useCallback((error) => {
    if (error instanceof ApiError && error.status === 401) {
      sessionEpoch.current += 1
      setUser(null)
      setPage('dashboard')
      notify('error', 'Sua sessão expirou. Entre novamente.')
      return
    }
    notify('error', error?.message || 'Não foi possível concluir a operação.')
  }, [notify])

  const loadSession = useCallback(async () => {
    const epoch = sessionEpoch.current
    try {
      const result = await api('/me')
      if (epoch !== sessionEpoch.current) return null
      setUser(result.user)
      setPermissionOptions(result.permission_options || [])
      return result.user
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        if (epoch === sessionEpoch.current) {
          sessionEpoch.current += 1
          setUser(null)
        }
        return null
      }
      throw error
    }
  }, [])

  useEffect(() => {
    let active = true
    async function boot() {
      try {
        const status = await api('/setup-status')
        if (!active) return
        setHasAdmin(status.has_admin)
        setSetupEnabled(status.setup_enabled !== false)
        setRecoveryEnabled(status.recovery_enabled === true)
        if (status.has_admin) await loadSession()
      } catch (error) {
        if (active) handleError(error)
      } finally {
        if (active) setBooting(false)
      }
    }
    boot()
    return () => { active = false }
  }, [handleError, loadSession])

  useEffect(() => {
    if (!user || user.must_change_password) return undefined
    const refresh = () => setRefreshSignal(Date.now())
    const interval = setInterval(refresh, 30_000)
    const visibility = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', visibility)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [user])

  useEffect(() => {
    if (!user || user.must_change_password) return
    loadSession().catch(handleError)
  }, [refreshSignal]) // eslint-disable-line react-hooks/exhaustive-deps

  const navigation = useMemo(() => {
    if (!user) return []
    if (user.role === 'admin') {
      return [
        ['dashboard', BarChart3, 'Visão geral'],
        ['inventory', Package, 'Estoque'],
        ['products', Layers3, 'Produtos'],
        ['movements', ClipboardList, 'Movimentações'],
        ['reports', FileSpreadsheet, 'Relatórios'],
        ['users', Users, 'Acessos'],
        ['audit', History, 'Auditoria'],
      ]
    }
    const items = []
    if (hasPermission(user, PERMISSIONS.CREATE_PRODUCTS)) items.push(['products', Layers3, 'Produtos'])
    if (hasPermission(user, PERMISSIONS.STOCK_ENTRY) || hasPermission(user, PERMISSIONS.STOCK_EXIT)) {
      items.push(['movements', ClipboardList, 'Entradas e saídas'])
    }
    return items
  }, [user])

  useEffect(() => {
    if (!user || navigation.length === 0) return
    if (!navigation.some(([id]) => id === page)) setPage(navigation[0][0])
  }, [navigation, page, user])

  async function logout() {
    sessionEpoch.current += 1
    setUser(null)
    setPage('dashboard')
    try {
      await api('/logout', { method: 'POST' })
    } catch {
      // A sessão local é encerrada mesmo se a rede falhar.
    }
  }

  function changePage(nextPage) {
    setPage(nextPage)
    setMenuOpen(false)
  }

  const noticeElement = notice && <Toast notice={notice} onClose={() => setNotice(null)} />

  if (booting) return <>{noticeElement}<LoadingScreen /></>
  if (!hasAdmin) {
    return <>{noticeElement}<SetupScreen setupEnabled={setupEnabled} onCreated={(result) => {
      sessionEpoch.current += 1
      setHasAdmin(true)
      setUser(result.user)
      setPermissionOptions(result.permission_options || [])
      setPage('dashboard')
      notify('success', 'Administrador criado com sucesso.')
    }} onError={handleError} /></>
  }
  if (!user) {
    return <>{noticeElement}<LoginScreen recoveryEnabled={recoveryEnabled} onLogin={(result) => {
      sessionEpoch.current += 1
      setUser(result.user)
      setPermissionOptions(result.permission_options || [])
      setPage('dashboard')
      notify('success', `Acesso liberado, ${result.user.name}.`)
    }} onError={handleError} /></>
  }
  if (user.must_change_password) {
    return <>{noticeElement}<ForcedPasswordChange user={user} onChanged={(updatedUser) => {
      sessionEpoch.current += 1
      setUser(updatedUser)
      notify('success', 'Senha alterada. Seu acesso está liberado.')
    }} onLogout={logout} onError={handleError} /></>
  }

  return (
    <div className="app-shell">
      {noticeElement}
      <button className="mobile-menu-button no-print" onClick={() => setMenuOpen(true)} aria-label="Abrir menu">
        <Menu size={22} />
      </button>
      {menuOpen && <button className="menu-backdrop no-print" onClick={() => setMenuOpen(false)} aria-label="Fechar menu" />}
      <aside className={`sidebar no-print ${menuOpen ? 'open' : ''}`}>
        <div className="brand-block">
          <div className="brand-mark">P</div>
          <div><strong>Pinguins</strong><span>Controle de estoque</span></div>
          <button className="sidebar-close" onClick={() => setMenuOpen(false)} aria-label="Fechar menu"><X size={20} /></button>
        </div>
        <nav>
          {navigation.map(([id, Icon, label]) => (
            <button key={id} className={page === id ? 'active' : ''} onClick={() => changePage(id)}>
              <Icon size={19} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button onClick={() => setShowPasswordChange(true)}><KeyRound size={18} />Alterar senha</button>
          <button onClick={logout}><LogOut size={18} />Sair</button>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar no-print">
          <div>
            <p className="eyebrow">{user.role === 'admin' ? 'Administrador' : 'Colaborador'}</p>
            <h1>{navigation.find(([id]) => id === page)?.[2] || 'Estoque'}</h1>
          </div>
          <div className="topbar-actions">
            <div className="user-chip"><ShieldCheck size={17} /><span>{user.name}</span></div>
            <button className="button secondary" onClick={() => setRefreshSignal(Date.now())}><RefreshCw size={17} />Atualizar</button>
          </div>
        </header>

        <div className="page-content">
          {page === 'dashboard' && user.role === 'admin' && <DashboardPage refreshSignal={refreshSignal} onError={handleError} />}
          {page === 'inventory' && user.role === 'admin' && <InventoryPage refreshSignal={refreshSignal} onError={handleError} />}
          {page === 'products' && <ProductsPage user={user} refreshSignal={refreshSignal} onRefresh={() => setRefreshSignal(Date.now())} notify={notify} onError={handleError} />}
          {page === 'movements' && <MovementsPage user={user} refreshSignal={refreshSignal} onRefresh={() => setRefreshSignal(Date.now())} notify={notify} onError={handleError} />}
          {page === 'reports' && user.role === 'admin' && <ReportsPage notify={notify} onError={handleError} />}
          {page === 'users' && user.role === 'admin' && <UsersPage permissionOptions={permissionOptions} refreshSignal={refreshSignal} notify={notify} onError={handleError} />}
          {page === 'audit' && user.role === 'admin' && <AuditPage refreshSignal={refreshSignal} onError={handleError} />}
          {navigation.length === 0 && <EmptyAccess />}
        </div>
      </main>

      {showPasswordChange && <PasswordChangeModal onClose={() => setShowPasswordChange(false)} onChanged={(updatedUser) => {
        sessionEpoch.current += 1
        setUser(updatedUser)
        setShowPasswordChange(false)
        notify('success', 'Senha alterada com sucesso.')
      }} onError={handleError} />}
    </div>
  )
}

function LoadingScreen() {
  return <div className="loading-screen"><div className="spinner" /><strong>Carregando o estoque...</strong></div>
}

function SetupScreen({ setupEnabled, onCreated, onError }) {
  const [form, setForm] = useState({ name: '', login: '', email: '', password: '', confirm_password: '', setup_secret: '' })
  const [submitting, setSubmitting] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  async function submit(event) {
    event.preventDefault()
    if (form.password !== form.confirm_password) {
      onError(new Error('A confirmação não corresponde à senha.'))
      return
    }
    setSubmitting(true)
    try {
      const result = await api('/setup-admin', { method: 'POST', body: form })
      onCreated(result)
    } catch (error) {
      onError(error)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout title="Criar administrador" subtitle="Configure o primeiro acesso exclusivo da gestão.">
      {!setupEnabled && <div className="auth-warning" role="alert">Configure a variável ADMIN_SETUP_SECRET na hospedagem antes de criar o administrador.</div>}
      <form className="form-stack" onSubmit={submit}>
        <Field label="Nome completo" required><input required value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} autoComplete="name" /></Field>
        <Field label="Login do administrador" hint="Use um nome de acesso simples ou um e-mail válido." required><input required minLength={3} maxLength={80} value={form.login} onChange={event => setForm({ ...form, login: event.target.value.toLowerCase() })} autoComplete="username" autoCapitalize="none" spellCheck={false} /></Field>
        <Field label="E-mail de contato" optional><input type="email" value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} autoComplete="email" /></Field>
        <Field label="Senha" hint="Mínimo de 10 caracteres, com letra e número." required>
          <PasswordInput visible={showPassword} value={form.password} onChange={value => setForm({ ...form, password: value })} onToggle={() => setShowPassword(value => !value)} autoComplete="new-password" minLength={10} />
        </Field>
        <Field label="Confirmar senha" required>
          <input required minLength={10} maxLength={200} type={showPassword ? 'text' : 'password'} value={form.confirm_password} onChange={event => setForm({ ...form, confirm_password: event.target.value })} autoComplete="new-password" />
        </Field>
        <Field label="Chave de instalação" hint="É a ADMIN_SETUP_SECRET configurada na hospedagem." required><input required maxLength={500} type="password" value={form.setup_secret} onChange={event => setForm({ ...form, setup_secret: event.target.value })} autoComplete="off" /></Field>
        <button className="button primary full" disabled={submitting || !setupEnabled}>{submitting ? 'Criando...' : 'Criar administrador'}</button>
      </form>
    </AuthLayout>
  )
}

function LoginScreen({ recoveryEnabled, onLogin, onError }) {
  const [mode, setMode] = useState('login')
  const [form, setForm] = useState({ login: '', password: '' })
  const [recoveryForm, setRecoveryForm] = useState({ login: '', new_password: '', confirm_password: '', recovery_secret: '' })
  const [submitting, setSubmitting] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  async function submit(event) {
    event.preventDefault()
    setSubmitting(true)
    try {
      const result = await api('/login', { method: 'POST', body: form })
      onLogin(result)
    } catch (error) {
      onError(error)
    } finally {
      setSubmitting(false)
    }
  }

  async function recover(event) {
    event.preventDefault()
    if (recoveryForm.new_password !== recoveryForm.confirm_password) {
      onError(new Error('A confirmação não corresponde à nova senha.'))
      return
    }
    setSubmitting(true)
    try {
      const result = await api('/recover-admin', { method: 'POST', body: recoveryForm })
      onLogin(result)
    } catch (error) {
      onError(error)
    } finally {
      setSubmitting(false)
    }
  }

  if (mode === 'recovery') {
    return (
      <AuthLayout title="Recuperar administrador" subtitle="Use a chave de recuperação protegida na hospedagem para definir uma nova senha.">
        <form className="form-stack" onSubmit={recover}>
          <Field label="Login do administrador" required><input required maxLength={80} value={recoveryForm.login} onChange={event => setRecoveryForm({ ...recoveryForm, login: event.target.value.toLowerCase() })} autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus /></Field>
          <Field label="Nova senha" hint="Mínimo de 10 caracteres, com letra e número." required>
            <PasswordInput visible={showPassword} value={recoveryForm.new_password} onChange={value => setRecoveryForm({ ...recoveryForm, new_password: value })} onToggle={() => setShowPassword(value => !value)} autoComplete="new-password" minLength={10} />
          </Field>
          <Field label="Confirmar nova senha" required>
            <input required minLength={10} maxLength={200} type={showPassword ? 'text' : 'password'} value={recoveryForm.confirm_password} onChange={event => setRecoveryForm({ ...recoveryForm, confirm_password: event.target.value })} autoComplete="new-password" />
          </Field>
          <Field label="Chave de recuperação" hint="É a ADMIN_RECOVERY_SECRET configurada na hospedagem." required><input required maxLength={500} type="password" value={recoveryForm.recovery_secret} onChange={event => setRecoveryForm({ ...recoveryForm, recovery_secret: event.target.value })} autoComplete="off" /></Field>
          <button className="button primary full" disabled={submitting}>{submitting ? 'Recuperando...' : 'Definir nova senha'}</button>
          <button type="button" className="button ghost full" onClick={() => { setMode('login'); setShowPassword(false) }}>Voltar ao login</button>
        </form>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout title="Acessar o estoque" subtitle="Entre com seu login individual e sua senha.">
      <form className="form-stack" onSubmit={submit}>
        <Field label="Login" required><input required maxLength={80} value={form.login} onChange={event => setForm({ ...form, login: event.target.value })} autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus /></Field>
        <Field label="Senha" required>
          <PasswordInput visible={showPassword} value={form.password} onChange={value => setForm({ ...form, password: value })} onToggle={() => setShowPassword(value => !value)} autoComplete="current-password" />
        </Field>
        <button className="button primary full" disabled={submitting}>{submitting ? 'Entrando...' : 'Entrar'}</button>
        {recoveryEnabled && <button type="button" className="button ghost full" onClick={() => { setMode('recovery'); setShowPassword(false) }}>Esqueci o acesso do administrador</button>}
      </form>
    </AuthLayout>
  )
}

function ForcedPasswordChange({ user, onChanged, onLogout, onError }) {
  return (
    <AuthLayout title="Crie sua senha definitiva" subtitle={`${user.name}, sua senha atual é temporária.`}>
      <PasswordChangeForm onChanged={onChanged} onError={onError} />
      <button className="button ghost full" onClick={onLogout}>Sair</button>
    </AuthLayout>
  )
}

function PasswordChangeModal({ onClose, onChanged, onError }) {
  return (
    <Modal title="Alterar senha" onClose={onClose}>
      <PasswordChangeForm onChanged={onChanged} onError={onError} />
    </Modal>
  )
}

function PasswordChangeForm({ onChanged, onError }) {
  const [form, setForm] = useState({ current_password: '', new_password: '', confirm_password: '' })
  const [submitting, setSubmitting] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  async function submit(event) {
    event.preventDefault()
    if (form.new_password !== form.confirm_password) {
      onError(new Error('A confirmação não corresponde à nova senha.'))
      return
    }
    setSubmitting(true)
    try {
      const result = await api('/change-password', {
        method: 'POST',
        body: { current_password: form.current_password, new_password: form.new_password },
      })
      onChanged(result.user)
    } catch (error) {
      onError(error)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="form-stack" onSubmit={submit}>
      <Field label="Senha atual" required><PasswordInput visible={showPassword} value={form.current_password} onChange={value => setForm({ ...form, current_password: value })} onToggle={() => setShowPassword(value => !value)} autoComplete="current-password" /></Field>
      <Field label="Nova senha" hint="Mínimo de 10 caracteres, com letra e número." required><PasswordInput visible={showPassword} value={form.new_password} onChange={value => setForm({ ...form, new_password: value })} onToggle={() => setShowPassword(value => !value)} autoComplete="new-password" minLength={10} /></Field>
      <Field label="Confirmar nova senha" required><PasswordInput visible={showPassword} value={form.confirm_password} onChange={value => setForm({ ...form, confirm_password: value })} onToggle={() => setShowPassword(value => !value)} autoComplete="new-password" minLength={10} /></Field>
      <button className="button primary full" disabled={submitting}>{submitting ? 'Salvando...' : 'Salvar nova senha'}</button>
    </form>
  )
}

function DashboardPage({ refreshSignal, onError }) {
  const [data, setData] = useState({ summary: {}, recent_movements: [] })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true)
    api('/dashboard').then(result => {
      if (active) setData(result)
    }).catch(onError).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [refreshSignal, onError])

  const summary = data.summary || {}
  return (
    <>
      <section className="metric-grid">
        <MetricCard label="Produtos ativos" value={summary.products || 0} icon={Package} tone="purple" loading={loading} />
        <MetricCard label="Estoque crítico" value={summary.critical || 0} icon={AlertTriangle} tone="pink" loading={loading} />
        <MetricCard label="Estoque baixo" value={summary.low || 0} icon={Settings2} tone="yellow" loading={loading} />
        <MetricCard label="Estoque bom" value={summary.good || 0} icon={Check} tone="blue" loading={loading} />
        <MetricCard label="Valor em estoque" value={formatMoney(summary.inventory_value)} icon={BarChart3} tone="lilac" loading={loading} wide />
      </section>
      <Card title="Últimas movimentações" subtitle="Atualização automática a cada 30 segundos.">
        <ResponsiveTable
          rows={data.recent_movements}
          empty="Nenhuma movimentação registrada."
          columns={[
            ['Data', row => formatDateTime(row.created_at)],
            ['Produto', 'product_name'],
            ['Tipo', row => <MovementBadge type={row.type} />],
            ['Quantidade', row => `${formatNumber(row.quantity)} ${row.unit}`],
            ['Responsável', 'created_by_name'],
            ['Status', row => row.status === 'annulled' ? <Badge tone="muted">Anulada</Badge> : <Badge tone="good">Ativa</Badge>],
          ]}
        />
      </Card>
    </>
  )
}

function InventoryPage({ refreshSignal, onError }) {
  const [categories, setCategories] = useState([])
  const [filters, setFilters] = useState({ q: '', category_id: '', status: '', min_quantity: '', max_quantity: '' })
  const [page, setPage] = useState(1)
  const [products, setProducts] = useState([])
  const [pagination, setPagination] = useState(EMPTY_PAGINATION)
  const [loading, setLoading] = useState(true)
  const debouncedSearch = useDebouncedValue(filters.q)

  useEffect(() => {
    api('/categories').then(result => setCategories(result.categories)).catch(onError)
  }, [onError])

  useEffect(() => {
    let active = true
    setLoading(true)
    const params = { ...filters, q: debouncedSearch, page, page_size: 20 }
    api(`/products${queryString(params)}`).then(result => {
      if (!active) return
      setProducts(result.products)
      setPagination(result.pagination)
    }).catch(onError).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [debouncedSearch, filters.category_id, filters.status, filters.min_quantity, filters.max_quantity, page, refreshSignal, onError])

  function updateFilter(key, value) {
    setFilters(current => ({ ...current, [key]: value }))
    setPage(1)
  }

  return (
    <Card title="Estoque atual" subtitle="Filtre por produto, categoria, quantidade e situação.">
      <FilterGrid>
        <Field label="Pesquisar produto"><SearchInput value={filters.q} onChange={value => updateFilter('q', value)} placeholder="Digite o nome" /></Field>
        <Field label="Categoria"><select value={filters.category_id} onChange={event => updateFilter('category_id', event.target.value)}><option value="">Todas</option><option value="none">Sem categoria</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></Field>
        <Field label="Situação"><select value={filters.status} onChange={event => updateFilter('status', event.target.value)}><option value="">Todas</option><option value="critical">Crítico</option><option value="low">Baixo</option><option value="good">Bom</option></select></Field>
        <Field label="Quantidade mínima"><input type="number" min="0" step="0.001" value={filters.min_quantity} onChange={event => updateFilter('min_quantity', event.target.value)} /></Field>
        <Field label="Quantidade máxima"><input type="number" min="0" step="0.001" value={filters.max_quantity} onChange={event => updateFilter('max_quantity', event.target.value)} /></Field>
      </FilterGrid>
      {loading ? <InlineLoading /> : (
        <ResponsiveTable
          rows={products}
          empty="Nenhum produto encontrado com esses filtros."
          columns={[
            ['Produto', 'name'],
            ['Categoria', row => row.category || 'Sem categoria'],
            ['Saldo', row => `${formatNumber(row.quantity)} ${row.unit}`],
            ['Limite crítico', row => formatNumber(row.critical_stock)],
            ['Limite baixo', row => formatNumber(row.low_stock)],
            ['Situação', row => <StockBadge status={row.status} />],
            ['Custo', row => formatMoney(row.cost)],
            ['Valor em estoque', row => formatMoney(row.inventory_value)],
          ]}
        />
      )}
      <Pagination pagination={pagination} onPage={setPage} />
    </Card>
  )
}

function ProductsPage({ user, refreshSignal, onRefresh, notify, onError }) {
  const isAdmin = user.role === 'admin'
  const [categories, setCategories] = useState([])
  const [products, setProducts] = useState([])
  const [pagination, setPagination] = useState(EMPTY_PAGINATION)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [activeFilter, setActiveFilter] = useState('true')
  const debouncedSearch = useDebouncedValue(search)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState(emptyProductForm())
  const [submitting, setSubmitting] = useState(false)
  const [categoryName, setCategoryName] = useState('')
  const [showCategories, setShowCategories] = useState(false)
  const [loading, setLoading] = useState(true)

  const loadCategories = useCallback(async () => {
    const result = await api('/categories')
    setCategories(result.categories)
  }, [])

  const loadProducts = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api(`/products${queryString({ q: debouncedSearch, active: isAdmin ? activeFilter : 'true', page, page_size: 20 })}`)
      setProducts(result.products)
      setPagination(result.pagination)
    } finally {
      setLoading(false)
    }
  }, [debouncedSearch, page, isAdmin, activeFilter])

  useEffect(() => { loadCategories().catch(onError) }, [loadCategories, refreshSignal, onError])
  useEffect(() => { loadProducts().catch(onError) }, [loadProducts, refreshSignal, onError])

  function resetForm() {
    setForm(emptyProductForm())
    setEditingId(null)
  }

  async function submit(event) {
    event.preventDefault()
    setSubmitting(true)
    try {
      await api(editingId ? `/products/${editingId}` : '/products', {
        method: editingId ? 'PUT' : 'POST',
        body: form,
      })
      notify('success', editingId ? 'Produto atualizado.' : 'Produto cadastrado com saldo zero. Registre uma entrada para adicionar quantidade.')
      resetForm()
      await loadProducts()
      onRefresh()
    } catch (error) {
      onError(error)
    } finally {
      setSubmitting(false)
    }
  }

  function editProduct(product) {
    setEditingId(product.id)
    setForm({
      name: product.name,
      category_id: product.category_id || '',
      unit: product.unit,
      critical_stock: product.critical_stock,
      low_stock: product.low_stock,
      cost: product.cost,
      price: product.price,
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function deactivate(product) {
    if (!window.confirm(`Desativar o produto "${product.name}"? O histórico será preservado.`)) return
    try {
      await api(`/products/${product.id}`, { method: 'DELETE' })
      notify('success', 'Produto desativado.')
      await loadProducts()
      onRefresh()
    } catch (error) {
      onError(error)
    }
  }

  async function reactivate(product) {
    try {
      await api(`/products/${product.id}/reactivate`, { method: 'POST', body: {} })
      notify('success', 'Produto reativado.')
      await loadProducts()
      onRefresh()
    } catch (error) {
      onError(error)
    }
  }

  async function addCategory(event) {
    event.preventDefault()
    try {
      await api('/categories', { method: 'POST', body: { name: categoryName } })
      setCategoryName('')
      await loadCategories()
      notify('success', 'Categoria adicionada.')
    } catch (error) {
      onError(error)
    }
  }

  async function removeCategory(category) {
    if (!window.confirm(`Excluir a categoria "${category.name}"? Os produtos ficarão sem categoria.`)) return
    try {
      await api(`/categories/${category.id}`, { method: 'DELETE' })
      await loadCategories()
      await loadProducts()
      if (form.category_id === category.id) setForm(current => ({ ...current, category_id: '' }))
      notify('success', 'Categoria excluída.')
    } catch (error) {
      onError(error)
    }
  }

  return (
    <>
      <Card title={editingId ? 'Editar produto' : 'Cadastrar produto'} subtitle={isAdmin ? 'A quantidade não é alterada aqui. Todo saldo deve passar por movimentação ou ajuste.' : 'O produto será criado com saldo zero.'}>
        <form className="form-grid" onSubmit={submit}>
          <Field label="Nome do produto" required><input required maxLength={150} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></Field>
          <Field label="Categoria" optional><select value={form.category_id} onChange={event => setForm({ ...form, category_id: event.target.value })}><option value="">Sem categoria</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></Field>
          <Field label="Unidade de medida" required><select required value={form.unit} onChange={event => setForm({ ...form, unit: event.target.value })}>{UNITS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
          {isAdmin && <>
            <Field label="Limite crítico" hint="Saldo igual ou menor será crítico." required><input required type="number" min="0" step="0.001" value={form.critical_stock} onChange={event => setForm({ ...form, critical_stock: event.target.value })} /></Field>
            <Field label="Limite baixo" hint="Deve ser igual ou maior que o crítico." required><input required type="number" min="0" step="0.001" value={form.low_stock} onChange={event => setForm({ ...form, low_stock: event.target.value })} /></Field>
            <Field label="Custo unitário" required><input required type="number" min="0" step="0.01" value={form.cost} onChange={event => setForm({ ...form, cost: event.target.value })} /></Field>
            <Field label="Preço de venda" required><input required type="number" min="0" step="0.01" value={form.price} onChange={event => setForm({ ...form, price: event.target.value })} /></Field>
          </>}
          <div className="form-actions span-all">
            <button className="button primary" disabled={submitting}>{submitting ? 'Salvando...' : editingId ? 'Salvar alterações' : 'Cadastrar produto'}</button>
            {editingId && <button type="button" className="button secondary" onClick={resetForm}>Cancelar edição</button>}
          </div>
        </form>
      </Card>

      {isAdmin && <Card title="Categorias" subtitle="A categoria é opcional. Use esta área somente para organizar o catálogo." compact>
        <button className="button secondary" onClick={() => setShowCategories(value => !value)}><Settings2 size={17} />{showCategories ? 'Ocultar categorias' : 'Gerenciar categorias'}</button>
        {showCategories && <div className="category-manager">
          <form className="inline-form" onSubmit={addCategory}><input required maxLength={80} placeholder="Nova categoria" value={categoryName} onChange={event => setCategoryName(event.target.value)} /><button className="button primary"><Plus size={17} />Adicionar</button></form>
          <div className="tag-list">{categories.map(category => <span className="tag" key={category.id}>{category.name}<button onClick={() => removeCategory(category)} aria-label={`Excluir ${category.name}`}><X size={14} /></button></span>)}</div>
        </div>}
      </Card>}

      <Card title="Produtos cadastrados" subtitle={`${pagination.total} produto(s) ${!isAdmin || activeFilter === 'true' ? 'ativo(s)' : activeFilter === 'false' ? 'inativo(s)' : 'no total'}.`}>
        <div className="toolbar">
          <SearchInput value={search} onChange={value => { setSearch(value); setPage(1) }} placeholder="Pesquisar produto" />
          {isAdmin && <select aria-label="Filtrar produtos por situação" value={activeFilter} onChange={event => { setActiveFilter(event.target.value); setPage(1); resetForm() }}><option value="true">Ativos</option><option value="false">Inativos</option><option value="all">Todos</option></select>}
        </div>
        {loading ? <InlineLoading /> : <ResponsiveTable
          rows={products}
          empty="Nenhum produto encontrado."
          columns={[
            ['Produto', 'name'],
            ['Categoria', row => row.category || 'Sem categoria'],
            ['Unidade', 'unit'],
            ['Saldo', row => `${formatNumber(row.quantity)} ${row.unit}`],
            ['Situação', row => row.active === false ? <Badge tone="muted">Inativo</Badge> : <StockBadge status={row.status} />],
            ...(isAdmin ? [
              ['Limites', row => `Crítico ${formatNumber(row.critical_stock)} | Baixo ${formatNumber(row.low_stock)}`],
              ['Ações', row => row.active === false
                ? <button className="button text" onClick={() => reactivate(row)}>Reativar</button>
                : <div className="table-actions"><button className="icon-button" onClick={() => editProduct(row)} aria-label="Editar produto"><Edit3 size={17} /></button><button className="icon-button danger" onClick={() => deactivate(row)} aria-label="Desativar produto"><Trash2 size={17} /></button></div>],
            ] : []),
          ]}
        />}
        <Pagination pagination={pagination} onPage={setPage} />
      </Card>
    </>
  )
}

function emptyProductForm() {
  return { name: '', category_id: '', unit: 'unidade', critical_stock: '0', low_stock: '0', cost: '0', price: '0' }
}

function MovementsPage({ user, refreshSignal, onRefresh, notify, onError }) {
  const isAdmin = user.role === 'admin'
  const allowedTypes = useMemo(() => {
    const types = []
    if (hasPermission(user, PERMISSIONS.STOCK_ENTRY)) types.push('entrada')
    if (hasPermission(user, PERMISSIONS.STOCK_EXIT)) types.push('saida')
    return types
  }, [user])
  const [selectedProduct, setSelectedProduct] = useState(null)
  const [comboVersion, setComboVersion] = useState(0)
  const [form, setForm] = useState({ type: allowedTypes[0] || 'entrada', quantity: '', note: '', idempotency_key: newIdempotencyKey() })
  const [submitting, setSubmitting] = useState(false)
  const [movements, setMovements] = useState([])
  const [pagination, setPagination] = useState(EMPTY_PAGINATION)
  const [page, setPage] = useState(1)
  const [filters, setFilters] = useState({ q: '', type: '', status: '', origin: '', date_from: '', date_to: '', min_quantity: '', max_quantity: '', user_id: '' })
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [annulMovement, setAnnulMovement] = useState(null)
  const [showAdjustment, setShowAdjustment] = useState(false)
  const debouncedSearch = useDebouncedValue(filters.q)

  useEffect(() => {
    if (!allowedTypes.includes(form.type) && allowedTypes[0]) setForm(current => ({ ...current, type: allowedTypes[0] }))
  }, [allowedTypes, form.type])

  useEffect(() => {
    if (!isAdmin) return
    api('/movement-users').then(result => setUsers(result.users)).catch(onError)
  }, [isAdmin, refreshSignal, onError])

  const loadMovements = useCallback(async () => {
    setLoading(true)
    try {
      const params = isAdmin ? { ...filters, q: debouncedSearch, page, page_size: 20 } : { page, page_size: 20 }
      const result = await api(`/movements${queryString(params)}`)
      setMovements(result.movements)
      setPagination(result.pagination)
    } finally {
      setLoading(false)
    }
  }, [isAdmin, debouncedSearch, filters.type, filters.status, filters.origin, filters.date_from, filters.date_to, filters.min_quantity, filters.max_quantity, filters.user_id, page])

  useEffect(() => { loadMovements().catch(onError) }, [loadMovements, refreshSignal, onError])

  async function submit(event) {
    event.preventDefault()
    if (!selectedProduct) {
      onError(new Error('Selecione um produto da lista de pesquisa.'))
      return
    }
    setSubmitting(true)
    try {
      await api('/movements', {
        method: 'POST',
        body: { ...form, product_id: selectedProduct.id },
      })
      notify('success', `${movementTypeLabel(form.type)} registrada com sucesso.`)
      setSelectedProduct(null)
      setComboVersion(value => value + 1)
      setForm(current => ({ ...current, quantity: '', note: '', idempotency_key: newIdempotencyKey() }))
      await loadMovements()
      onRefresh()
    } catch (error) {
      onError(error)
    } finally {
      setSubmitting(false)
    }
  }

  function updateFilter(key, value) {
    setFilters(current => ({ ...current, [key]: value }))
    setPage(1)
  }

  return (
    <>
      <Card title="Nova movimentação" subtitle="Pesquise o produto pelo nome e registre a quantidade exata.">
        <form className="form-grid" onSubmit={submit}>
          <Field label="Produto" required><ProductCombobox key={comboVersion} value={selectedProduct} onSelect={setSelectedProduct} onError={onError} /></Field>
          <Field label="Tipo" required><select required value={form.type} onChange={event => setForm({ ...form, type: event.target.value })}>{allowedTypes.map(type => <option key={type} value={type}>{movementTypeLabel(type)}</option>)}</select></Field>
          <Field label="Quantidade" required><input required type="number" min="0.001" step="0.001" value={form.quantity} onChange={event => setForm({ ...form, quantity: event.target.value })} /></Field>
          <Field label="Observação" optional><input maxLength={500} value={form.note} onChange={event => setForm({ ...form, note: event.target.value })} placeholder="Exemplo: compra semanal" /></Field>
          <div className="form-actions span-all"><button className="button primary" disabled={submitting || allowedTypes.length === 0}>{submitting ? 'Registrando...' : 'Registrar movimentação'}</button></div>
        </form>
      </Card>

      {isAdmin && <Card title="Ajuste administrativo" subtitle="Use somente para corrigir uma divergência encontrada na contagem física." compact>
        <button className="button secondary" onClick={() => setShowAdjustment(value => !value)}><RotateCcw size={17} />{showAdjustment ? 'Ocultar ajuste' : 'Fazer ajuste de saldo'}</button>
        {showAdjustment && <AdjustmentForm onDone={async () => { setShowAdjustment(false); await loadMovements(); onRefresh() }} notify={notify} onError={onError} />}
      </Card>}

      <Card title={isAdmin ? 'Histórico de movimentações' : 'Meus últimos lançamentos'} subtitle={isAdmin ? 'Filtros por data, quantidade, tipo, status e responsável.' : 'Você visualiza apenas as movimentações feitas pelo seu acesso.'}>
        {isAdmin && <FilterGrid>
          <Field label="Produto"><SearchInput value={filters.q} onChange={value => updateFilter('q', value)} placeholder="Nome do produto" /></Field>
          <Field label="Data inicial"><input type="date" value={filters.date_from} onChange={event => updateFilter('date_from', event.target.value)} /></Field>
          <Field label="Data final"><input type="date" value={filters.date_to} onChange={event => updateFilter('date_to', event.target.value)} /></Field>
          <Field label="Tipo"><select value={filters.type} onChange={event => updateFilter('type', event.target.value)}><option value="">Todos</option><option value="entrada">Entrada</option><option value="saida">Saída</option></select></Field>
          <Field label="Origem"><select value={filters.origin} onChange={event => updateFilter('origin', event.target.value)}><option value="">Todas</option><option value="manual">Lançamento</option><option value="adjustment">Ajuste</option><option value="annulment">Reversão</option></select></Field>
          <Field label="Status"><select value={filters.status} onChange={event => updateFilter('status', event.target.value)}><option value="">Todos</option><option value="active">Ativa</option><option value="annulled">Anulada</option></select></Field>
          <Field label="Quantidade mínima"><input type="number" min="0" step="0.001" value={filters.min_quantity} onChange={event => updateFilter('min_quantity', event.target.value)} /></Field>
          <Field label="Quantidade máxima"><input type="number" min="0" step="0.001" value={filters.max_quantity} onChange={event => updateFilter('max_quantity', event.target.value)} /></Field>
          <Field label="Responsável"><select value={filters.user_id} onChange={event => updateFilter('user_id', event.target.value)}><option value="">Todos</option>{users.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
        </FilterGrid>}
        {loading ? <InlineLoading /> : <ResponsiveTable
          rows={movements}
          empty="Nenhuma movimentação encontrada."
          columns={[
            ['Data', row => formatDateTime(row.created_at)],
            ['Produto', 'product_name'],
            ['Tipo', row => <MovementBadge type={row.type} />],
            ['Origem', row => movementOriginLabel(row.origin)],
            ['Quantidade', row => `${formatNumber(row.quantity)} ${row.unit}`],
            ['Saldo', row => row.balance_after === null ? 'Legado' : `${formatNumber(row.balance_before)} para ${formatNumber(row.balance_after)}`],
            ['Responsável', 'created_by_name'],
            ['Status', row => row.status === 'annulled' ? <Badge tone="muted">Anulada</Badge> : <Badge tone="good">Ativa</Badge>],
            ...(isAdmin ? [['Ação', row => row.status === 'active' && row.origin !== 'annulment' ? <button className="button text danger-text" onClick={() => setAnnulMovement(row)}>Anular</button> : '']] : []),
          ]}
        />}
        <Pagination pagination={pagination} onPage={setPage} />
      </Card>

      {annulMovement && <AnnulModal movement={annulMovement} onClose={() => setAnnulMovement(null)} onDone={async () => {
        setAnnulMovement(null)
        notify('success', 'Movimentação anulada e saldo revertido.')
        await loadMovements()
        onRefresh()
      }} onError={onError} />}
    </>
  )
}

function AdjustmentForm({ onDone, notify, onError }) {
  const [product, setProduct] = useState(null)
  const [form, setForm] = useState({ target_quantity: '', reason: '', idempotency_key: newIdempotencyKey() })
  const [submitting, setSubmitting] = useState(false)

  async function submit(event) {
    event.preventDefault()
    if (!product) return onError(new Error('Selecione um produto.'))
    setSubmitting(true)
    try {
      await api('/adjustments', { method: 'POST', body: { ...form, product_id: product.id } })
      notify('success', 'Saldo ajustado com registro no histórico.')
      await onDone()
    } catch (error) {
      onError(error)
    } finally {
      setSubmitting(false)
    }
  }

  return <form className="form-grid nested-form" onSubmit={submit}>
    <Field label="Produto" required><ProductCombobox value={product} onSelect={setProduct} onError={onError} /></Field>
    <Field label="Quantidade correta" required><input required type="number" min="0" step="0.001" value={form.target_quantity} onChange={event => setForm({ ...form, target_quantity: event.target.value })} /></Field>
    <Field label="Motivo da correção" required><input required maxLength={500} value={form.reason} onChange={event => setForm({ ...form, reason: event.target.value })} /></Field>
    <div className="form-actions span-all"><button className="button primary" disabled={submitting}>{submitting ? 'Ajustando...' : 'Confirmar ajuste'}</button></div>
  </form>
}

function AnnulModal({ movement, onClose, onDone, onError }) {
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  async function submit(event) {
    event.preventDefault()
    setSubmitting(true)
    try {
      await api(`/movements/${movement.id}/annul`, { method: 'POST', body: { reason } })
      await onDone()
    } catch (error) {
      onError(error)
    } finally {
      setSubmitting(false)
    }
  }
  return <Modal title="Anular movimentação" onClose={onClose}>
    <p className="modal-copy">A movimentação de <strong>{movementTypeLabel(movement.type).toLowerCase()}</strong> de <strong>{formatNumber(movement.quantity)} {movement.unit}</strong> para <strong>{movement.product_name}</strong> será revertida. O registro original continuará na auditoria.</p>
    <form className="form-stack" onSubmit={submit}>
      <Field label="Motivo da anulação" required><textarea required maxLength={500} value={reason} onChange={event => setReason(event.target.value)} rows={4} /></Field>
      <div className="form-actions"><button className="button danger" disabled={submitting}>{submitting ? 'Anulando...' : 'Anular e reverter saldo'}</button><button type="button" className="button secondary" onClick={onClose}>Cancelar</button></div>
    </form>
  </Modal>
}

function ReportsPage({ notify, onError }) {
  const [stockFilters, setStockFilters] = useState({ q: '', category_id: '', status: '', min_quantity: '', max_quantity: '' })
  const [movementFilters, setMovementFilters] = useState({ q: '', category: '', date_from: '', date_to: '', type: '', status: '', origin: '', min_quantity: '', max_quantity: '', user_id: '' })
  const [categories, setCategories] = useState([])
  const [users, setUsers] = useState([])
  const [downloading, setDownloading] = useState('')

  useEffect(() => {
    Promise.all([api('/categories'), api('/movement-users')]).then(([categoryResult, userResult]) => {
      setCategories(categoryResult.categories)
      setUsers(userResult.users)
    }).catch(onError)
  }, [onError])

  async function doDownload(type) {
    setDownloading(type)
    try {
      if (type === 'stock') await download(`/export/stock.csv${queryString(stockFilters)}`, 'estoque-pinguins.csv')
      else await download(`/export/movements.csv${queryString(movementFilters)}`, 'movimentacoes-pinguins.csv')
      notify('success', 'Relatório gerado em CSV, compatível com Excel e Google Planilhas.')
    } catch (error) {
      onError(error)
    } finally {
      setDownloading('')
    }
  }

  return <div className="report-grid">
    <Card title="Relatório de estoque" subtitle="A exportação respeita os filtros selecionados.">
      <FilterGrid>
        <Field label="Produto"><SearchInput value={stockFilters.q} onChange={value => setStockFilters({ ...stockFilters, q: value })} /></Field>
        <Field label="Categoria"><select value={stockFilters.category_id} onChange={event => setStockFilters({ ...stockFilters, category_id: event.target.value })}><option value="">Todas</option><option value="none">Sem categoria</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></Field>
        <Field label="Situação"><select value={stockFilters.status} onChange={event => setStockFilters({ ...stockFilters, status: event.target.value })}><option value="">Todas</option><option value="critical">Crítico</option><option value="low">Baixo</option><option value="good">Bom</option></select></Field>
        <Field label="Quantidade mínima"><input type="number" min="0" step="0.001" value={stockFilters.min_quantity} onChange={event => setStockFilters({ ...stockFilters, min_quantity: event.target.value })} /></Field>
        <Field label="Quantidade máxima"><input type="number" min="0" step="0.001" value={stockFilters.max_quantity} onChange={event => setStockFilters({ ...stockFilters, max_quantity: event.target.value })} /></Field>
      </FilterGrid>
      <div className="form-actions"><button className="button primary" disabled={downloading === 'stock'} onClick={() => doDownload('stock')}><Download size={17} />{downloading === 'stock' ? 'Gerando...' : 'Baixar estoque em CSV'}</button></div>
    </Card>

    <Card title="Relatório de movimentações" subtitle="Filtre por período, tipo, origem, quantidade e status.">
      <FilterGrid>
        <Field label="Produto"><SearchInput value={movementFilters.q} onChange={value => setMovementFilters({ ...movementFilters, q: value })} /></Field>
        <Field label="Categoria"><select value={movementFilters.category} onChange={event => setMovementFilters({ ...movementFilters, category: event.target.value })}><option value="">Todas</option><option value="none">Sem categoria</option>{categories.map(category => <option key={category.id} value={category.name}>{category.name}</option>)}</select></Field>
        <Field label="Data inicial"><input type="date" value={movementFilters.date_from} onChange={event => setMovementFilters({ ...movementFilters, date_from: event.target.value })} /></Field>
        <Field label="Data final"><input type="date" value={movementFilters.date_to} onChange={event => setMovementFilters({ ...movementFilters, date_to: event.target.value })} /></Field>
        <Field label="Tipo"><select value={movementFilters.type} onChange={event => setMovementFilters({ ...movementFilters, type: event.target.value })}><option value="">Todos</option><option value="entrada">Entrada</option><option value="saida">Saída</option></select></Field>
        <Field label="Origem"><select value={movementFilters.origin} onChange={event => setMovementFilters({ ...movementFilters, origin: event.target.value })}><option value="">Todas</option><option value="manual">Lançamento</option><option value="adjustment">Ajuste</option><option value="annulment">Reversão</option></select></Field>
        <Field label="Status"><select value={movementFilters.status} onChange={event => setMovementFilters({ ...movementFilters, status: event.target.value })}><option value="">Todos</option><option value="active">Ativa</option><option value="annulled">Anulada</option></select></Field>
        <Field label="Quantidade mínima"><input type="number" min="0" step="0.001" value={movementFilters.min_quantity} onChange={event => setMovementFilters({ ...movementFilters, min_quantity: event.target.value })} /></Field>
        <Field label="Quantidade máxima"><input type="number" min="0" step="0.001" value={movementFilters.max_quantity} onChange={event => setMovementFilters({ ...movementFilters, max_quantity: event.target.value })} /></Field>
        <Field label="Responsável"><select value={movementFilters.user_id} onChange={event => setMovementFilters({ ...movementFilters, user_id: event.target.value })}><option value="">Todos</option>{users.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
      </FilterGrid>
      <div className="form-actions"><button className="button primary" disabled={downloading === 'movements'} onClick={() => doDownload('movements')}><Download size={17} />{downloading === 'movements' ? 'Gerando...' : 'Baixar movimentações em CSV'}</button></div>
    </Card>
  </div>
}

function UsersPage({ permissionOptions, refreshSignal, notify, onError }) {
  const [users, setUsers] = useState([])
  const [form, setForm] = useState(emptyUserForm(permissionOptions))
  const [editingId, setEditingId] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [credentials, setCredentials] = useState(null)
  const [showPassword, setShowPassword] = useState(false)

  const loadUsers = useCallback(async () => {
    const result = await api('/users')
    setUsers(result.users)
  }, [])

  useEffect(() => { loadUsers().catch(onError) }, [loadUsers, refreshSignal, onError])
  useEffect(() => {
    if (!editingId) setForm(emptyUserForm(permissionOptions))
  }, [permissionOptions, editingId])

  function togglePermission(key) {
    setForm(current => ({ ...current, permissions: { ...current.permissions, [key]: !current.permissions[key] } }))
  }

  async function submit(event) {
    event.preventDefault()
    setSubmitting(true)
    try {
      if (editingId) {
        await api(`/users/${editingId}`, { method: 'PATCH', body: { name: form.name, login: form.login, email: form.email, permissions: form.permissions, active: form.active } })
        notify('success', 'Acesso atualizado. As sessões anteriores foram encerradas.')
      } else {
        const result = await api('/users', { method: 'POST', body: { name: form.name, login: form.login, email: form.email, password: form.password, permissions: form.permissions } })
        setCredentials({ login: result.user.login, password: result.temporary_password, name: result.user.name })
        notify('success', 'Colaborador criado.')
      }
      setEditingId(null)
      setForm(emptyUserForm(permissionOptions))
      await loadUsers()
    } catch (error) {
      onError(error)
    } finally {
      setSubmitting(false)
    }
  }

  function edit(item) {
    setEditingId(item.id)
    setForm({ name: item.name, login: item.login, email: item.email || '', password: '', active: item.active, permissions: item.permissions || {} })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function toggleActive(item) {
    try {
      await api(`/users/${item.id}`, { method: 'PATCH', body: { active: !item.active } })
      notify('success', item.active ? 'Acesso desativado.' : 'Acesso reativado.')
      await loadUsers()
    } catch (error) {
      onError(error)
    }
  }

  async function resetPassword(item) {
    if (!window.confirm(`Gerar uma nova senha temporária para ${item.name}?`)) return
    try {
      const result = await api(`/users/${item.id}/reset-password`, { method: 'POST', body: {} })
      setCredentials({ login: item.login, password: result.temporary_password, name: item.name })
      notify('success', 'Senha redefinida e sessões anteriores encerradas.')
    } catch (error) {
      onError(error)
    }
  }

  return <>
    <Card title={editingId ? 'Editar colaborador' : 'Criar acesso de colaborador'} subtitle="Cada pessoa recebe login próprio. Marque somente as funções necessárias.">
      <form className="form-grid" onSubmit={submit}>
        <Field label="Nome" required><input required value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></Field>
        <Field label="Login exclusivo" hint="Use um nome de acesso simples ou um e-mail válido." required><input required minLength={3} maxLength={80} value={form.login} onChange={event => setForm({ ...form, login: event.target.value.toLowerCase() })} autoComplete="off" autoCapitalize="none" spellCheck={false} /></Field>
        <Field label="E-mail" optional><input type="email" value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} /></Field>
        {!editingId && <Field label="Senha temporária" hint="Deixe vazio para gerar automaticamente." optional><PasswordInput visible={showPassword} value={form.password} onChange={value => setForm({ ...form, password: value })} onToggle={() => setShowPassword(value => !value)} autoComplete="new-password" required={false} minLength={10} /></Field>}
        <fieldset className="permission-box span-all"><legend>Funções permitidas</legend>{permissionOptions.map(option => <label className="check-row" key={option.key}><input type="checkbox" checked={form.permissions[option.key] === true} onChange={() => togglePermission(option.key)} /><span><Check size={16} />{option.label}</span></label>)}</fieldset>
        <div className="form-actions span-all"><button className="button primary" disabled={submitting}>{submitting ? 'Salvando...' : editingId ? 'Salvar acesso' : 'Criar colaborador'}</button>{editingId && <button type="button" className="button secondary" onClick={() => { setEditingId(null); setForm(emptyUserForm(permissionOptions)) }}>Cancelar</button>}</div>
      </form>
    </Card>

    <Card title="Colaboradores" subtitle={`${users.length} acesso(s) cadastrado(s).`}>
      <ResponsiveTable rows={users} empty="Nenhum colaborador cadastrado." columns={[
        ['Nome', 'name'],
        ['Login', 'login'],
        ['Funções', row => permissionOptions.filter(option => row.permissions?.[option.key]).map(option => option.label).join(', ') || 'Sem funções'],
        ['Último acesso', row => row.last_login_at ? formatDateTime(row.last_login_at) : 'Nunca acessou'],
        ['Status', row => row.active ? <Badge tone="good">Ativo</Badge> : <Badge tone="muted">Inativo</Badge>],
        ['Ações', row => <div className="table-actions"><button className="icon-button" onClick={() => edit(row)} title="Editar"><Edit3 size={17} /></button><button className="icon-button" onClick={() => resetPassword(row)} title="Redefinir senha"><KeyRound size={17} /></button><button className={`button text ${row.active ? 'danger-text' : ''}`} onClick={() => toggleActive(row)}>{row.active ? 'Desativar' : 'Ativar'}</button></div>],
      ]} />
    </Card>

    {credentials && <CredentialsModal credentials={credentials} onClose={() => setCredentials(null)} />}
  </>
}

function emptyUserForm(permissionOptions = []) {
  return {
    name: '',
    login: '',
    email: '',
    password: '',
    active: true,
    permissions: Object.fromEntries(permissionOptions.map(option => [option.key, false])),
  }
}

function CredentialsModal({ credentials, onClose }) {
  const [copied, setCopied] = useState(false)
  const textToCopy = `Acesso ao estoque Pinguins\nLogin: ${credentials.login}\nSenha temporária: ${credentials.password}`
  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(textToCopy)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = textToCopy
        textarea.setAttribute('readonly', '')
        textarea.className = 'clipboard-helper'
        document.body.appendChild(textarea)
        textarea.select()
        const copiedSuccessfully = document.execCommand('copy')
        textarea.remove()
        if (!copiedSuccessfully) throw new Error('Falha ao copiar.')
      }
      setCopied(true)
    } catch {
      window.prompt('Copie as credenciais abaixo:', textToCopy)
    }
  }
  return <Modal title="Credenciais do colaborador" onClose={onClose}>
    <p className="modal-copy">Envie estes dados somente para <strong>{credentials.name}</strong>. A troca da senha será obrigatória no primeiro acesso.</p>
    <div className="credentials-box"><span>Login</span><strong>{credentials.login}</strong><span>Senha temporária</span><strong>{credentials.password}</strong></div>
    <div className="form-actions"><button className="button primary" onClick={copy}>{copied ? <Check size={17} /> : <ClipboardList size={17} />}{copied ? 'Copiado' : 'Copiar credenciais'}</button><button className="button secondary" onClick={onClose}>Fechar</button></div>
  </Modal>
}

function AuditPage({ refreshSignal, onError }) {
  const [logs, setLogs] = useState([])
  const [pagination, setPagination] = useState(EMPTY_PAGINATION)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true)
    api(`/audit${queryString({ page, page_size: 30 })}`).then(result => {
      if (!active) return
      setLogs(result.logs)
      setPagination(result.pagination)
    }).catch(onError).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [page, refreshSignal, onError])

  return <Card title="Auditoria administrativa" subtitle="Registro de alterações sensíveis do sistema.">
    {loading ? <InlineLoading /> : <ResponsiveTable rows={logs} empty="Nenhuma ação administrativa registrada." columns={[
      ['Data', row => formatDateTime(row.created_at)],
      ['Responsável', 'actor_name'],
      ['Ação', row => auditActionLabel(row.action)],
      ['Entidade', row => row.entity_type],
      ['Detalhes', row => summarizeDetails(row.details)],
    ]} />}
    <Pagination pagination={pagination} onPage={setPage} />
  </Card>
}

function auditActionLabel(action) {
  return ({
    'admin.created': 'Administrador criado',
    'admin.recovered': 'Acesso administrativo recuperado',
    'user.password_changed': 'Senha alterada',
    'user.created': 'Colaborador criado',
    'user.updated': 'Colaborador atualizado',
    'user.password_reset': 'Senha redefinida',
    'category.created': 'Categoria criada',
    'product.created': 'Produto criado',
    'product.updated': 'Produto atualizado',
    'product.deactivated': 'Produto desativado',
    'product.reactivated': 'Produto reativado',
    'category.deleted': 'Categoria excluída',
    'stock.adjusted': 'Saldo ajustado',
    'movement.annulled': 'Movimentação anulada',
  })[action] || action
}

function summarizeDetails(details) {
  if (!details || typeof details !== 'object') return 'Sem detalhes'
  return Object.entries(details).slice(0, 4).map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`).join(' | ')
}

function ProductCombobox({ value, onSelect, onError }) {
  const [query, setQuery] = useState(value?.name || '')
  const [options, setOptions] = useState([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const debounced = useDebouncedValue(query, 180)
  const requestId = useRef(0)
  const listboxId = useId()

  useEffect(() => {
    setQuery(value?.name || '')
  }, [value])

  useEffect(() => {
    if (!open) return
    const currentRequest = ++requestId.current
    setLoading(true)
    api(`/products/options${queryString({ q: debounced, page: 1, page_size: 20 })}`).then(result => {
      if (currentRequest !== requestId.current) return
      setOptions(result.products)
      setHighlighted(0)
    }).catch(onError).finally(() => {
      if (currentRequest === requestId.current) setLoading(false)
    })
  }, [debounced, open, onError])

  function select(product) {
    onSelect(product)
    setQuery(product.name)
    setOpen(false)
  }

  function keyDown(event) {
    if (!open && ['ArrowDown', 'ArrowUp'].includes(event.key)) setOpen(true)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (options.length) setHighlighted(index => Math.min(options.length - 1, index + 1))
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (options.length) setHighlighted(index => Math.max(0, index - 1))
    }
    if (event.key === 'Enter' && open && options[highlighted]) {
      event.preventDefault()
      select(options[highlighted])
    }
    if (event.key === 'Escape') setOpen(false)
  }

  return <div className="combobox">
    <div className="search-input"><Search size={17} /><input required value={query} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} onKeyDown={keyDown} onChange={event => { setQuery(event.target.value); onSelect(null); setOpen(true) }} placeholder="Digite as primeiras letras" role="combobox" aria-expanded={open} aria-autocomplete="list" aria-haspopup="listbox" aria-controls={listboxId} aria-activedescendant={open && options[highlighted] ? `${listboxId}-${options[highlighted].id}` : undefined} /></div>
    {open && <div className="combobox-list" role="listbox" id={listboxId} aria-busy={loading}>
      {loading && <div className="combobox-message">Pesquisando...</div>}
      {!loading && options.length === 0 && <div className="combobox-message">Nenhum produto encontrado.</div>}
      {!loading && options.map((product, index) => <button id={`${listboxId}-${product.id}`} type="button" role="option" aria-selected={index === highlighted} className={index === highlighted ? 'highlighted' : ''} key={product.id} onMouseEnter={() => setHighlighted(index)} onMouseDown={event => event.preventDefault()} onClick={() => select(product)}><span><strong>{product.name}</strong><small>{product.category || 'Sem categoria'} | {formatNumber(product.quantity)} {product.unit}</small></span><StockBadge status={product.status} /></button>)}
    </div>}
  </div>
}

function AuthLayout({ title, subtitle, children }) {
  return <div className="auth-page"><div className="auth-panel"><div className="auth-brand"><div className="brand-mark large">P</div><span>Sorveteria Pinguins</span></div><h1>{title}</h1><p>{subtitle}</p>{children}</div><div className="auth-visual"><div className="visual-circle one" /><div className="visual-circle two" /><div className="visual-circle three" /><div className="visual-copy"><strong>Estoque organizado.</strong><span>Operação simples, segura e rastreável.</span></div></div></div>
}

function Card({ title, subtitle, children, compact = false }) {
  return <section className={`card ${compact ? 'compact' : ''}`}><div className="card-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div></div>{children}</section>
}

function Field({ label, hint, optional, required, children }) {
  return <label className="field"><span className="field-label">{label}{required && <em>*</em>}{optional && <small>opcional</small>}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>
}

function FilterGrid({ children }) {
  return <div className="filter-grid">{children}</div>
}

function PasswordInput({ visible, value, onChange, onToggle, autoComplete, required = true, minLength }) {
  return <div className="password-input"><input required={required} minLength={minLength} maxLength={200} type={visible ? 'text' : 'password'} value={value} onChange={event => onChange(event.target.value)} autoComplete={autoComplete} /><button type="button" onClick={onToggle} aria-label={visible ? 'Ocultar senha' : 'Mostrar senha'}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button></div>
}

function SearchInput({ value, onChange, placeholder = 'Pesquisar' }) {
  return <div className="search-input"><Search size={17} /><input value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} aria-label={placeholder} /></div>
}

function ResponsiveTable({ rows, columns, empty }) {
  if (!rows?.length) return <div className="empty-state"><Package size={28} /><p>{empty}</p></div>
  return <div className="table-wrap"><table><thead><tr>{columns.map(([heading]) => <th key={heading}>{heading}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={row.id || rowIndex}>{columns.map(([heading, accessor]) => <td key={heading} data-label={heading}>{typeof accessor === 'function' ? accessor(row) : row[accessor]}</td>)}</tr>)}</tbody></table></div>
}

function Pagination({ pagination, onPage }) {
  if (!pagination || pagination.pages <= 1) return null
  return <div className="pagination"><button className="icon-button" disabled={pagination.page <= 1} onClick={() => onPage(pagination.page - 1)} aria-label="Página anterior"><ChevronLeft size={18} /></button><span>Página <strong>{pagination.page}</strong> de <strong>{pagination.pages}</strong> | {pagination.total} registro(s)</span><button className="icon-button" disabled={pagination.page >= pagination.pages} onClick={() => onPage(pagination.page + 1)} aria-label="Próxima página"><ChevronRight size={18} /></button></div>
}

function MetricCard({ label, value, icon: Icon, tone, loading, wide }) {
  return <div className={`metric-card ${tone} ${wide ? 'wide' : ''}`}><div className="metric-icon"><Icon size={22} /></div><div><span>{label}</span><strong>{loading ? '...' : value}</strong></div></div>
}

function Badge({ tone, children }) {
  return <span className={`badge ${tone}`}>{children}</span>
}

function StockBadge({ status }) {
  return <Badge tone={status}>{statusLabel(status)}</Badge>
}

function MovementBadge({ type }) {
  return <Badge tone={type === 'entrada' ? 'entry' : 'exit'}>{movementTypeLabel(type)}</Badge>
}

function Modal({ title, onClose, children }) {
  const titleId = useId()
  useEffect(() => {
    const handleKeyDown = event => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId}><div className="modal-header"><h2 id={titleId}>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Fechar" autoFocus><X size={19} /></button></div>{children}</div></div>
}

function Toast({ notice, onClose }) {
  useEffect(() => {
    const timeout = setTimeout(onClose, 5000)
    return () => clearTimeout(timeout)
  }, [notice.id, onClose])
  return <div className={`toast ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}><span>{notice.type === 'success' ? <Check size={18} /> : <AlertTriangle size={18} />}{notice.message}</span><button onClick={onClose} aria-label="Fechar aviso"><X size={16} /></button></div>
}

function InlineLoading() {
  return <div className="inline-loading"><div className="spinner small" />Carregando...</div>
}

function EmptyAccess() {
  return <Card title="Acesso sem funções"><div className="empty-state"><UserCog size={32} /><p>O administrador ainda não atribuiu funções ao seu usuário.</p></div></Card>
}
