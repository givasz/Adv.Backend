// Autenticação de usuário (advogado) — cadastro/login por e-mail + senha.
//
// Sem dependências novas: reutiliza `node:crypto` (mesmo espírito de admin-auth.ts).
//   • Senha  → scrypt com salt aleatório, guardada como "scrypt$<salt>$<hash>".
//   • Sessão → token JWT-like (payload base64url + assinatura HMAC-SHA256) com o
//     userId no `sub`, o id da sessão no `sid` e a expiração.
//
// A assinatura prova que o token é nosso; quem decide se ele ainda VALE é a linha
// Session no banco (ver auth/session.service.ts). Antes a sessão era só assinada, e
// isso significava que "sair" não podia ser cumprido: o servidor não tinha como
// saber que aquele token tinha sido descartado, e ele seguia entrando por 7 dias.
//
// Configuração (env):
//   AUTH_SESSION_SECRET  segredo p/ assinar a sessão (fallback: ADMIN_SESSION_SECRET)
//
// ⚠️ Em produção defina AUTH_SESSION_SECRET forte.

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { requireSecret } from '../security/config'

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7 // 7 dias

function sessionSecret(): string {
  // Em produção, requireSecret recusa valores conhecidos/vazios: melhor invalidar
  // toda sessão do que assinar com um segredo que está no repositório.
  return requireSecret(
    [process.env.AUTH_SESSION_SECRET, process.env.ADMIN_SESSION_SECRET],
    'dev-user-secret',
  )
}

/** Comparação resistente a timing (buffers de mesmo tamanho). */
function safeEqualBuf(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

// Parâmetros do scrypt para hashes NOVOS. Os antigos continuam válidos: o hash
// carrega os próprios parâmetros ("scrypt$N=..,r=..,p=..$salt$hash") e o formato
// legado de 3 partes cai nos defaults do Node, que foi como ele foi gerado.
// N=32768/r=8 → ~33 MB por verificação; p=3 triplica o trabalho de CPU sem
// triplicar a memória (importante: a memória é o que um ataque de login paralelo
// transformaria em negação de serviço).
const SCRYPT = { N: 32768, r: 8, p: 3, keylen: 64, maxmem: 64 * 1024 * 1024 }
const LEGACY = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 }

function derive(password: string, salt: string, o: typeof SCRYPT): Buffer {
  return scryptSync(password, salt, o.keylen, { N: o.N, r: o.r, p: o.p, maxmem: o.maxmem })
}

/** Gera hash da senha: "scrypt$N=..,r=..,p=..$<salt hex>$<hash hex>". */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = derive(password, salt, SCRYPT).toString('hex')
  return `scrypt$N=${SCRYPT.N},r=${SCRYPT.r},p=${SCRYPT.p}$${salt}$${hash}`
}

/** Confere a senha contra o hash guardado (formato novo ou legado). */
export function verifyPassword(password: string, stored: string): boolean {
  const partes = (stored || '').split('$')
  if (partes[0] !== 'scrypt') return false

  let opts = LEGACY
  let salt: string | undefined
  let hash: string | undefined

  if (partes.length === 4) {
    const m = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(partes[1] ?? '')
    if (!m) return false
    opts = { ...SCRYPT, N: Number(m[1]), r: Number(m[2]), p: Number(m[3]) }
    // Teto de sanidade: um hash adulterado no banco não pode pedir 4 GB de RAM.
    if (opts.N > 1 << 20 || opts.r > 32 || opts.p > 16) return false
    salt = partes[2]
    hash = partes[3]
  } else if (partes.length === 3) {
    salt = partes[1]
    hash = partes[2]
  } else {
    return false
  }
  if (!salt || !hash) return false

  try {
    const test = derive(password, salt, opts)
    return safeEqualBuf(test, Buffer.from(hash, 'hex'))
  } catch {
    return false
  }
}

// Hash descartável, só para gastar o MESMO tempo quando o e-mail não existe.
// Sem isto, "login falhou rápido" significa "esta conta não existe" e a lista de
// clientes da plataforma vira consulta pública (ver login em auth.service.ts).
const DUMMY_HASH = hashPassword(randomBytes(24).toString('hex'))

/** Consome o tempo de uma verificação real. Sempre false. */
export function burnPasswordTime(password: string): boolean {
  return verifyPassword(password, DUMMY_HASH)
}

/** Duração de uma sessão. */
export const SESSION_TTL = SESSION_TTL_MS

export interface SessionPayload {
  userId: string
  sessionId: string
}

/** Emite o token assinado de uma sessão já criada no banco. */
export function issueUserSession(
  userId: string,
  sessionId: string,
  expiresAt: number,
): { token: string; expiresAt: number } {
  const payload = { sub: userId, sid: sessionId, exp: expiresAt }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', sessionSecret()).update(body).digest('base64url')
  return { token: `${body}.${sig}`, expiresAt }
}

/**
 * Confere assinatura e validade do token e devolve o que ele afirma.
 *
 * Isto sozinho NÃO autentica ninguém: diz apenas que o token saiu daqui e ainda
 * não venceu. Quem confirma que a sessão continua aberta é o SessionService, que
 * procura o `sessionId` no banco.
 */
export function readSessionToken(token?: string): SessionPayload | null {
  if (!token) return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  let expected: string
  try {
    expected = createHmac('sha256', sessionSecret()).update(body).digest('base64url')
  } catch {
    return null // segredo ausente em produção → nenhuma sessão vale
  }
  if (!safeEqualBuf(Buffer.from(sig), Buffer.from(expected))) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as {
      sub?: string
      sid?: string
      exp?: number
    }
    if (!payload.sub || !payload.sid) return null
    if (typeof payload.exp !== 'number' || payload.exp <= Date.now()) return null
    return { userId: payload.sub, sessionId: payload.sid }
  } catch {
    return null
  }
}

/** Lê o token do header `Authorization: Bearer <token>`. */
export function sessionFromHeader(authorization?: string): SessionPayload | null {
  if (!authorization) return null
  const [scheme, value] = authorization.split(' ')
  return scheme?.toLowerCase() === 'bearer' ? readSessionToken(value) : null
}
