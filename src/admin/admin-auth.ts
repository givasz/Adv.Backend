// Autenticação de administrador — login usuário/senha + token de sessão assinado.
//
// Sem dependências novas: usa `node:crypto` para HMAC. O token é um JWT-like
// simples (payload base64url + assinatura HMAC-SHA256) com expiração. Serve tanto
// para o painel de denúncias quanto para a fila de conferência de OAB.
//
// Configuração (env):
//   ADMIN_USERNAME        usuário do painel (default: "admin")
//   ADMIN_PASSWORD        senha do painel (fallback: ADMIN_TOKEN, depois "dev-admin-123")
//   ADMIN_SESSION_SECRET  segredo p/ assinar a sessão (fallback: ADMIN_TOKEN)
//
// ⚠️ Em produção defina ADMIN_PASSWORD e ADMIN_SESSION_SECRET fortes.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const SESSION_TTL_MS = 1000 * 60 * 60 * 8 // 8 horas

function adminUsername(): string {
  return process.env.ADMIN_USERNAME || 'admin'
}

/** Identificação do admin para registrar o "responsável" pela conferência de OAB. */
export function adminLabel(): string {
  return adminUsername()
}
function adminPassword(): string {
  return process.env.ADMIN_PASSWORD || process.env.ADMIN_TOKEN || 'dev-admin-123'
}
function sessionSecret(): string {
  return process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_TOKEN || 'dev-admin-secret'
}

/** Comparação de strings resistente a timing attacks. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/** Valida usuário/senha do painel. */
export function verifyCredentials(username?: string, password?: string): boolean {
  return safeEqual(username ?? '', adminUsername()) && safeEqual(password ?? '', adminPassword())
}

/** Emite um token de sessão assinado, com expiração. */
export function issueSession(): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + SESSION_TTL_MS
  const payload = { exp: expiresAt, nonce: randomBytes(8).toString('hex') }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', sessionSecret()).update(body).digest('base64url')
  return { token: `${body}.${sig}`, expiresAt }
}

/** Verifica assinatura e validade do token de sessão. */
export function verifySession(token?: string): boolean {
  if (!token) return false
  const [body, sig] = token.split('.')
  if (!body || !sig) return false
  const expected = createHmac('sha256', sessionSecret()).update(body).digest('base64url')
  if (!safeEqual(sig, expected)) return false
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as { exp?: number }
    return typeof payload.exp === 'number' && payload.exp > Date.now()
  } catch {
    return false
  }
}

/** Extrai o token do header `Authorization: Bearer <token>`. */
export function bearerFromHeader(authorization?: string): string | undefined {
  if (!authorization) return undefined
  const [scheme, value] = authorization.split(' ')
  return scheme?.toLowerCase() === 'bearer' ? value : undefined
}

/**
 * Verdadeiro se a requisição está autenticada como admin, seja pela sessão
 * (Authorization: Bearer) ou pelo token estático legado (x-admin-token = ADMIN_TOKEN).
 */
export function isAdminAuthenticated(authorization?: string, adminToken?: string): boolean {
  if (verifySession(bearerFromHeader(authorization))) return true
  const staticToken = process.env.ADMIN_TOKEN
  return !!staticToken && !!adminToken && safeEqual(adminToken, staticToken)
}
