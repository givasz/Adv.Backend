import { describe, expect, it } from 'vitest'
import {
  hashPassword,
  issueUserSession,
  userIdFromHeader,
  verifyPassword,
  verifyUserSession,
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

describe('sessão', () => {
  it('token emitido é aceito e devolve o dono', () => {
    const { token } = issueUserSession('user-1')
    expect(verifyUserSession(token)).toBe('user-1')
    expect(userIdFromHeader(`Bearer ${token}`)).toBe('user-1')
  })

  it('recusa token forjado, sem assinatura ou de outro payload', () => {
    const { token } = issueUserSession('user-1')
    const [body, sig] = token.split('.')
    const outroBody = Buffer.from(
      JSON.stringify({ sub: 'user-2', exp: Date.now() + 60_000 }),
    ).toString('base64url')

    expect(verifyUserSession(`${outroBody}.${sig}`)).toBeNull() // troca de dono
    expect(verifyUserSession(body)).toBeNull() // sem assinatura
    expect(verifyUserSession(`${body}.`)).toBeNull()
    expect(verifyUserSession('')).toBeNull()
    expect(verifyUserSession(undefined)).toBeNull()
    expect(verifyUserSession('lixo.lixo')).toBeNull()
  })

  it('recusa token expirado', () => {
    const body = Buffer.from(JSON.stringify({ sub: 'u', exp: Date.now() - 1 })).toString('base64url')
    expect(verifyUserSession(`${body}.qualquer`)).toBeNull()
  })

  it('só o esquema Bearer é aceito no header', () => {
    const { token } = issueUserSession('user-1')
    expect(userIdFromHeader(token)).toBeNull()
    expect(userIdFromHeader(`Basic ${token}`)).toBeNull()
    expect(userIdFromHeader(undefined)).toBeNull()
  })
})
