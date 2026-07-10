// Autenticação de usuário (advogado) — cadastro/login por e-mail + senha.
//
// Sem dependências novas: reutiliza `node:crypto` (mesmo espírito de admin-auth.ts).
//   • Senha  → scrypt com salt aleatório, guardada como "scrypt$<salt>$<hash>".
//   • Sessão → token JWT-like (payload base64url + assinatura HMAC-SHA256) com o
//     userId no `sub` e expiração. Verificável sem estado no servidor.
//
// Configuração (env):
//   AUTH_SESSION_SECRET  segredo p/ assinar a sessão (fallback: ADMIN_SESSION_SECRET)
//
// ⚠️ Em produção defina AUTH_SESSION_SECRET forte.

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7 // 7 dias

function sessionSecret(): string {
  return process.env.AUTH_SESSION_SECRET || process.env.ADMIN_SESSION_SECRET || 'dev-user-secret'
}

/** Comparação resistente a timing (buffers de mesmo tamanho). */
function safeEqualBuf(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Gera hash da senha: "scrypt$<salt hex>$<hash hex>". */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `scrypt$${salt}$${hash}`
}

/** Confere a senha contra o hash guardado. */
export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = (stored || '').split('$')
  if (scheme !== 'scrypt' || !salt || !hash) return false
  const test = scryptSync(password, salt, 64)
  return safeEqualBuf(test, Buffer.from(hash, 'hex'))
}

/** Emite um token de sessão assinado com o userId e expiração. */
export function issueUserSession(userId: string): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + SESSION_TTL_MS
  const payload = { sub: userId, exp: expiresAt, nonce: randomBytes(6).toString('hex') }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', sessionSecret()).update(body).digest('base64url')
  return { token: `${body}.${sig}`, expiresAt }
}

/** Verifica assinatura + validade e devolve o userId (ou null). */
export function verifyUserSession(token?: string): string | null {
  if (!token) return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  const expected = createHmac('sha256', sessionSecret()).update(body).digest('base64url')
  if (!safeEqualBuf(Buffer.from(sig), Buffer.from(expected))) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as {
      sub?: string
      exp?: number
    }
    if (!payload.sub || typeof payload.exp !== 'number' || payload.exp <= Date.now()) return null
    return payload.sub
  } catch {
    return null
  }
}

/** Extrai o userId do header `Authorization: Bearer <token>` (ou null). */
export function userIdFromHeader(authorization?: string): string | null {
  if (!authorization) return null
  const [scheme, value] = authorization.split(' ')
  return scheme?.toLowerCase() === 'bearer' ? verifyUserSession(value) : null
}
