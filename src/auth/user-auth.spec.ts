import { describe, expect, it } from 'vitest'
import {
  credencialConfere,
  duracaoSessao,
  hashPassword,
  lerCookie,
  montarCookie,
  novaCredencial,
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

describe('credencial da sessão', () => {
  it('o segredo confere com o hash guardado', () => {
    const { secret, hash } = novaCredencial()
    expect(credencialConfere(secret, hash)).toBe(true)
    expect(credencialConfere('outro-segredo', hash)).toBe(false)
    expect(credencialConfere('', hash)).toBe(false)
    expect(credencialConfere(secret, '')).toBe(false)
  })

  it('o hash não contém o segredo — um dump do banco não devolve sessão', () => {
    const { secret, hash } = novaCredencial()
    expect(hash).not.toContain(secret)
    expect(hash).toHaveLength(64)
  })

  it('dois sorteios nunca coincidem', () => {
    const a = novaCredencial()
    const b = novaCredencial()
    expect(a.secret).not.toBe(b.secret)
    // 256 bits de entropia: adivinhar não é uma estratégia.
    expect(Buffer.from(a.secret, 'base64url')).toHaveLength(32)
  })

  it('o cookie leva id e segredo, e volta inteiro', () => {
    const valor = montarCookie('abc123', 'segredo-bem-comprido-aqui')
    expect(lerCookie(valor)).toEqual({ sessionId: 'abc123', secret: 'segredo-bem-comprido-aqui' })
  })

  it('cookie malformado vira null (falha fechada)', () => {
    expect(lerCookie(undefined)).toBeNull()
    expect(lerCookie('')).toBeNull()
    expect(lerCookie('sem-ponto')).toBeNull()
    expect(lerCookie('.so-segredo-comprido-aqui')).toBeNull()
    expect(lerCookie('id.')).toBeNull()
    expect(lerCookie('id.curto')).toBeNull() // segredo pequeno demais para ser nosso
  })
})

describe('duração da sessão', () => {
  it('"lembrar de mim" dura mais e sobrevive ao fechar do navegador', () => {
    const lembrada = duracaoSessao(true)
    const avulsa = duracaoSessao(false)
    expect(lembrada.persistente).toBe(true)
    expect(avulsa.persistente).toBe(false)
    expect(lembrada.idleMs).toBeGreaterThan(avulsa.idleMs)
  })

  it('o teto absoluto nunca é menor que o prazo de inatividade', () => {
    for (const lembrar of [true, false]) {
      const d = duracaoSessao(lembrar)
      expect(d.absolutoMs).toBeGreaterThanOrEqual(d.idleMs)
    }
  })
})
