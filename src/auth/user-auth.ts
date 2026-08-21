// Autenticação de usuário (advogado) — cadastro/login por e-mail + senha.
//
// Sem dependências novas: reutiliza `node:crypto` (mesmo espírito de admin-auth.ts).
//   • Senha   → scrypt com salt aleatório, guardada como "scrypt$<salt>$<hash>".
//   • Sessão  → segredo aleatório de 32 bytes entregue no cookie HttpOnly; o
//     banco guarda apenas o SHA-256 dele.
//
// Por que o segredo aleatório substituiu o token assinado (HMAC): o token antigo
// carregava o id da sessão e valia por ser nosso. Duas consequências ruins.
// Primeira, o id de sessão é um cuid — não é aleatório de verdade —, então quem
// obtivesse o segredo de assinatura poderia fabricar sessões plausíveis. Segunda,
// o valor guardado no banco (o id) ERA metade da credencial. Agora não: o que
// viaja no cookie é sorteado com 256 bits de entropia e o que fica no banco é um
// hash — um dump do Postgres não devolve a sessão de ninguém.
//
// Configuração (env):
//   AUTH_SESSION_HOURS          duração ociosa sem "lembrar de mim" (padrão 12)
//   AUTH_SESSION_REMEMBER_DAYS  duração ociosa com "lembrar de mim" (padrão 30)
//   AUTH_SESSION_MAX_DAYS       teto absoluto da sessão lembrada (padrão 180)
//   AUTH_SESSION_SECRET         segredo do token anti-CSRF (ver csrf.ts)

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/** Comparação resistente a timing (buffers de mesmo tamanho). */
function safeEqualBuf(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

// ---- Senha ------------------------------------------------------------------

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

// ---- Duração da sessão ------------------------------------------------------

const HORA = 1000 * 60 * 60
const DIA = HORA * 24

function numeroEnv(nome: string, padrao: number, max: number): number {
  const n = Number(process.env[nome])
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : padrao
}

export interface DuracaoSessao {
  /** Quanto tempo de inatividade a sessão suporta antes de vencer. */
  idleMs: number
  /** Teto absoluto: nem renovando, a sessão passa daqui. */
  absolutoMs: number
  /**
   * O cookie sobrevive ao fechar do navegador?
   *
   * Sem "lembrar de mim" ele é um cookie de sessão do navegador: sai junto com a
   * janela. Com, ele tem Max-Age e volta amanhã — que é o comportamento que o
   * Netlify e afins entregam por padrão.
   */
  persistente: boolean
}

/**
 * Quanto dura uma sessão, com e sem "lembrar de mim".
 *
 * O teto absoluto existe porque só renovar não basta: uma sessão usada todo dia
 * viveria para sempre, e um cookie roubado junto com ela. Passado o teto, é
 * senha de novo — inclusive para o ladrão.
 */
export function duracaoSessao(lembrar: boolean): DuracaoSessao {
  if (lembrar) {
    const idleMs = numeroEnv('AUTH_SESSION_REMEMBER_DAYS', 30, 365) * DIA
    const absolutoMs = Math.max(idleMs, numeroEnv('AUTH_SESSION_MAX_DAYS', 180, 730) * DIA)
    return { idleMs, absolutoMs, persistente: true }
  }
  const idleMs = numeroEnv('AUTH_SESSION_HOURS', 12, 24 * 30) * HORA
  return { idleMs, absolutoMs: Math.max(idleMs, 24 * HORA), persistente: false }
}

// ---- Credencial da sessão ---------------------------------------------------

export interface CredencialSessao {
  /** Vai no cookie. Nunca é guardado. */
  secret: string
  /** Vai para o banco/Redis. Não serve para entrar. */
  hash: string
}

/** Sorteia a credencial de uma sessão nova. */
export function novaCredencial(): CredencialSessao {
  const secret = randomBytes(32).toString('base64url')
  return { secret, hash: hashCredencial(secret) }
}

/** SHA-256 do segredo. Não é scrypt de propósito: o valor já é aleatório de
 *  256 bits, não há dicionário a resistir, e isso roda a cada requisição. */
export function hashCredencial(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/** O segredo apresentado corresponde ao hash guardado? */
export function credencialConfere(secret: string, hashGuardado: string): boolean {
  if (!secret || !hashGuardado) return false
  try {
    return safeEqualBuf(Buffer.from(hashCredencial(secret), 'hex'), Buffer.from(hashGuardado, 'hex'))
  } catch {
    return false
  }
}

export interface ValorCookie {
  sessionId: string
  secret: string
}

/**
 * Valor do cookie: "<id da sessão>.<segredo>".
 *
 * O id anda junto para que a busca seja por chave primária — uma leitura, sem
 * varredura de tabela. Quem autentica é o segredo.
 */
export function montarCookie(sessionId: string, secret: string): string {
  return `${sessionId}.${secret}`
}

/** Lê o valor do cookie. Formato errado → null (falha fechada). */
export function lerCookie(valor?: string): ValorCookie | null {
  if (!valor) return null
  const ponto = valor.indexOf('.')
  if (ponto < 1) return null
  const sessionId = valor.slice(0, ponto)
  const secret = valor.slice(ponto + 1)
  if (!sessionId || !secret || secret.length < 20) return null
  return { sessionId, secret }
}
