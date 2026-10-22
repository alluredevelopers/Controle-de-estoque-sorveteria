import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from './constants.js'
import { HttpError, text } from './validation.js'

export function jwtSecret() {
  const secret = process.env.JWT_SECRET
  if (
    !secret
    || secret.length < 32
    || /(substitua|change[-_ ]?me|placeholder|exemplo|example)/i.test(secret)
  ) {
    throw new Error('JWT_SECRET deve ser configurado com pelo menos 32 caracteres e não pode usar um valor de exemplo.')
  }
  return secret
}

export function createSessionToken(user) {
  return jwt.sign(
    { id: user.id, sv: Number(user.session_version || 1) },
    jwtSecret(),
    {
      algorithm: 'HS256',
      audience: 'pinguins-estoque-web',
      issuer: 'pinguins-estoque-api',
      expiresIn: SESSION_MAX_AGE_SECONDS,
    },
  )
}

export function verifySessionToken(token) {
  return jwt.verify(token, jwtSecret(), {
    algorithms: ['HS256'],
    audience: 'pinguins-estoque-web',
    issuer: 'pinguins-estoque-api',
  })
}

export function parseCookies(req) {
  const cookieHeader = text(req.headers.cookie)
  if (!cookieHeader) return {}
  return Object.fromEntries(cookieHeader.split(';').map(part => {
    const index = part.indexOf('=')
    const key = index >= 0 ? part.slice(0, index).trim() : part.trim()
    const encodedValue = index >= 0 ? part.slice(index + 1).trim() : ''
    try {
      return [key, decodeURIComponent(encodedValue)]
    } catch {
      return [key, '']
    }
  }))
}

export function sessionTokenFromRequest(req) {
  const cookies = parseCookies(req)
  if (cookies[SESSION_COOKIE]) return cookies[SESSION_COOKIE]
  const authorization = text(req.headers.authorization)
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  return match?.[1] || null
}

export function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV ? '; Secure' : ''
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`)
}

export function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV ? '; Secure' : ''
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`)
}

export function randomCredential(length = 16) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  return Array.from({ length }, () => alphabet[crypto.randomInt(0, alphabet.length)]).join('')
}

export function randomLogin(prefix = 'colab') {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

export function clientIp(req) {
  const forwarded = text(req.headers['x-forwarded-for']).split(',')[0].trim()
  return forwarded || text(req.socket?.remoteAddress) || 'unknown'
}

export function assertSameOrigin(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return
  const fetchSite = text(req.headers['sec-fetch-site'])
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) {
    throw new HttpError(403, 'Origem da requisição não autorizada.')
  }
  const origin = text(req.headers.origin)
  if (!origin) return
  const host = text(req.headers['x-forwarded-host'] || req.headers.host)
  try {
    if (new URL(origin).host !== host) throw new HttpError(403, 'Origem da requisição não autorizada.')
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(403, 'Origem da requisição inválida.')
  }
}
