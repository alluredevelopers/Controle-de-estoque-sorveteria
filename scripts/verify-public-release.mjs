import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join, relative, sep } from 'node:path'
import process from 'node:process'

const root = process.cwd()
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', '.vercel', 'coverage'])
const contentExclusions = new Set([
  '.env.example',
  'scripts/verify-public-release.mjs',
])
const forbiddenExactNames = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.test',
  'credentials.json',
  'service-account.json',
])
const forbiddenExtensions = new Set([
  '.pem', '.key', '.p12', '.pfx', '.jks', '.keystore',
  '.sqlite', '.sqlite3', '.dump', '.bak', '.backup',
  '.csv', '.xls', '.xlsx',
])

const secretPatterns = [
  ['chave privada', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['token pessoal do GitHub', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/],
  ['token refinado do GitHub', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['chave de acesso da AWS', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['token da Vercel', /\bvercel_[A-Za-z0-9_-]{20,}\b/i],
  ['string PostgreSQL com credenciais', /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+\/[A-Za-z0-9_.-]+/i],
  ['segredo JWT preenchido', /\bJWT_SECRET\s*=\s*(?!substitua|change|example|placeholder)[^\s#]{16,}/i],
  ['chave de instalação preenchida', /\bADMIN_SETUP_SECRET\s*=\s*(?!substitua|change|example|placeholder)[^\s#]{16,}/i],
  ['chave de recuperação preenchida', /\bADMIN_RECOVERY_SECRET\s*=\s*(?!substitua|change|example|placeholder)[^\s#]{20,}/i],
]

const findings = []

function normalizePath(path) {
  return relative(root, path).split(sep).join('/')
}

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
    const fullPath = join(directory, entry.name)
    const relativePath = normalizePath(fullPath)

    if (entry.isDirectory()) {
      await walk(fullPath)
      continue
    }
    if (!entry.isFile()) continue

    const name = basename(entry.name).toLowerCase()
    const extension = extname(entry.name).toLowerCase()
    if (forbiddenExactNames.has(name) || (name.startsWith('.env.') && name !== '.env.example')) {
      findings.push(`${relativePath}: arquivo de ambiente real não pode ser publicado.`)
    }
    if (forbiddenExtensions.has(extension)) {
      findings.push(`${relativePath}: tipo de arquivo potencialmente sensível não permitido no repositório público.`)
    }

    if (contentExclusions.has(relativePath)) continue
    const metadata = await stat(fullPath)
    if (metadata.size > 2_000_000) {
      findings.push(`${relativePath}: arquivo maior que 2 MB precisa de revisão manual antes da publicação.`)
      continue
    }

    const buffer = await readFile(fullPath)
    if (buffer.includes(0)) continue
    const content = buffer.toString('utf8')
    for (const [label, pattern] of secretPatterns) {
      if (pattern.test(content)) findings.push(`${relativePath}: possível ${label}.`)
    }
  }
}

await walk(root)

if (findings.length) {
  console.error('Publicação bloqueada. Revise os itens abaixo:')
  for (const finding of [...new Set(findings)].sort()) console.error(`- ${finding}`)
  process.exitCode = 1
} else {
  console.log('Verificação de publicação concluída: nenhum segredo ou arquivo sensível conhecido foi encontrado.')
}
