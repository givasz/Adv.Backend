import { describe, expect, it } from 'vitest'
import {
  hashPassword,
  issueUserSession,
  readSessionToken,
  sessionFromHeader,
  verifyPassword,
} from './user-auth'

describe('senha', () => {
  it('hash não guarda a senha e confere corretamente', () => {
    const h = hashPassword('cavalo-bateria-grampo')
    expect(h).not.toContain('cavalo')
    expect(h.startsWith('scrypt$N=')).toBe(true)
    expect(verifyPassword('cavalo-bateria-grampo', h)).toBe(true)
    expect(verifyPassword('cavalo-bateria-grampa', h)).toBe(false)
  })

  it('dois hashes da mesma senha são diferentes (salt aleatório)', () => {
    expect(hashPassword('mesma-senha-aqui')).not.toBe(hashPassword('mesma-senha-aqui'))
  })

  it('hash malformado ou adulterado nunca autentica', () => {
    expect(verifyPassword('x', '')).toBe(false)
    expect(verifyPassword('x', 'md5$abc$def')).toBe(false)
    expect(verifyPassword('x', 'scrypt$sem-hash')).toBe(false)
    // Parâmetros absurdos plantados no banco não podem pedir memória infinita.
    expect(verifyPassword('x', 'scrypt$N=99999999,r=99,p=99$aa$bb')).toBe(false)
  })
})

describe('token de sessão', () => {
  const EXP = () => Date.now() + 60_000

  it('token emitido é aceito e diz de quem é e de qual sessão', () => {
    const { token } = issueUserSession('user-1', 'sess-1', EXP())
    expect(readSessionToken(token)).toEqual({ userId: 'user-1', sessionId: 'sess-1' })
    expect(sessionFromHeader(`Bearer ${token}`)).toEqual({ userId: 'user-1', sessionId: 'sess-1' })
  })

  it('recusa token forjado, sem assinatura ou com o dono trocado', () => {
    const { token } = issueUserSession('user-1', 'sess-1', EXP())
    const [body, sig] = token.split('.')
    const outroBody = Buffer.from(
      JSON.stringify({ sub: 'user-2', sid: 'sess-1', exp: EXP() }),
    ).toString('base64url')

    expect(readSessionToken(`${outroBody}.${sig}`)).toBeNull() // troca de dono
    expect(readSessionToken(body)).toBeNull() // sem assinatura
    expect(readSessionToken(`${body}.`)).toBeNull()
    expect(readSessionToken('')).toBeNull()
    expect(readSessionToken(undefined)).toBeNull()
    expect(readSessionToken('lixo.lixo')).toBeNull()
  })

  it('recusa token expirado e token sem id de sessão', () => {
    const vencido = Buffer.from(
      JSON.stringify({ sub: 'u', sid: 's', exp: Date.now() - 1 }),
    ).toString('base64url')
    expect(readSessionToken(`${vencido}.qualquer`)).toBeNull()

    // Token no formato antigo (sem `sid`) não vale mais: sem id de sessão não há
    // linha no banco para conferir, e era exatamente esse o token irrevogável.
    const antigo = Buffer.from(JSON.stringify({ sub: 'u', exp: EXP() })).toString('base64url')
    expect(readSessionToken(`${antigo}.qualquer`)).toBeNull()
  })

  it('só o esquema Bearer é aceito no header', () => {
    const { token } = issueUserSession('user-1', 'sess-1', EXP())
    expect(sessionFromHeader(token)).toBeNull()
    expect(sessionFromHeader(`Basic ${token}`)).toBeNull()
    expect(sessionFromHeader(undefined)).toBeNull()
  })
})
