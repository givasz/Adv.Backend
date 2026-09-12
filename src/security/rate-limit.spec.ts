import { beforeEach, describe, expect, it } from 'vitest'
import { HttpException } from '@nestjs/common'
import {
  AI_GERACOES_POR_DIA,
  AI_RATE_RULES,
  AUTH_RATE_RULES,
  tetoGlobalPorHora,
  checkRateLimit,
  enforceRateLimit,
  proximaVaga,
  regraDoDia,
  resetRateLimits,
  restantes,
} from './rate-limit'
import { clientIp } from './net'

beforeEach(() => resetRateLimits())

describe('checkRateLimit', () => {
  it('libera até o teto e barra o excedente', () => {
    const regra = { windowMs: 60_000, max: 3 }
    expect(checkRateLimit('k', regra)).toBe(true)
    expect(checkRateLimit('k', regra)).toBe(true)
    expect(checkRateLimit('k', regra)).toBe(true)
    expect(checkRateLimit('k', regra)).toBe(false)
    expect(checkRateLimit('k', regra)).toBe(false)
  })

  it('conta cada chave separadamente', () => {
    const regra = { windowMs: 60_000, max: 1 }
    expect(checkRateLimit('a', regra)).toBe(true)
    expect(checkRateLimit('b', regra)).toBe(true)
    expect(checkRateLimit('a', regra)).toBe(false)
  })
})

describe('enforceRateLimit', () => {
  it('lança 429 quando estoura', () => {
    const tentar = () => enforceRateLimit([['login:ip:1.2.3.4', AUTH_RATE_RULES.loginPerIp]])
    for (let i = 0; i < AUTH_RATE_RULES.loginPerIp.max; i++) tentar()
    expect(tentar).toThrow(HttpException)
    try {
      tentar()
    } catch (e) {
      expect((e as HttpException).getStatus()).toBe(429)
    }
  })

  it('o teto por e-mail segura o ataque de dicionário mesmo trocando de IP', () => {
    const porEmail = (ip: string) =>
      enforceRateLimit([
        [`login:ip:${ip}`, AUTH_RATE_RULES.loginPerIp],
        ['login:email:alvo@exemplo.com', AUTH_RATE_RULES.loginPerEmail],
      ])
    for (let i = 0; i < AUTH_RATE_RULES.loginPerEmail.max; i++) porEmail(`10.0.0.${i}`)
    expect(() => porEmail('10.0.1.1')).toThrow(HttpException)
  })
})

describe('clientIp', () => {
  it('ignora X-Forwarded-For sem TRUST_PROXY — senão o limite se zera a cada requisição', () => {
    // TRUST_PROXY não está ligado no ambiente de teste.
    expect(clientIp('9.9.9.9', '1.1.1.1')).toBe('9.9.9.9')
    expect(clientIp(undefined, '1.1.1.1')).toBe('sem-ip')
  })
})

// Os tetos da IA protegem COTA de tier grátis, que é de todo mundo.
describe('tetos da IA', () => {
  it('o global vem do .env quando faz sentido, e tem padrão quando não', () => {
    expect(tetoGlobalPorHora({} as never)).toBe(300)
    expect(tetoGlobalPorHora({ AI_TETO_GLOBAL_HORA: '120' } as never)).toBe(120)
    expect(tetoGlobalPorHora({ AI_TETO_GLOBAL_HORA: 'muito' } as never)).toBe(300)
    expect(tetoGlobalPorHora({ AI_TETO_GLOBAL_HORA: '0' } as never)).toBe(300)
  })

  it('o dia cresce com o plano, e o maior cabe folgado no global de uma hora', () => {
    const d = AI_GERACOES_POR_DIA
    expect(d.anonimo).toBeLessThan(d.free)
    expect(d.free).toBeLessThan(d.pro)
    expect(d.pro).toBeLessThan(d.premium)
    expect(d.premium).toBeLessThan(AI_RATE_RULES.global.max)
    expect(regraDoDia('free').windowMs).toBe(24 * 60 * 60 * 1000)
  })

  it('o teto por IP no dia comporta algumas contas atrás do mesmo endereço', () => {
    expect(AI_RATE_RULES.perIpDayTotal.max).toBeGreaterThanOrEqual(2 * AI_GERACOES_POR_DIA.premium)
  })
})

describe('restantes e proximaVaga — só olham', () => {
  it('contam o que falta e dizem quando abre, sem registrar acesso', () => {
    const regra = { windowMs: 60_000, max: 2 }
    expect(restantes('k', regra)).toBe(2)
    expect(proximaVaga('k', regra)).toBeNull()
    checkRateLimit('k', regra)
    checkRateLimit('k', regra)
    expect(restantes('k', regra)).toBe(0)
    const vaga = proximaVaga('k', regra)!
    expect(vaga).toBeGreaterThan(Date.now())
    expect(vaga).toBeLessThanOrEqual(Date.now() + 60_000)
    expect(restantes('k', regra)).toBe(0)
  })

  it('a mensagem do 429 pode depender da regra que estourou', () => {
    const regra = { windowMs: 60_000, max: 1 }
    enforceRateLimit([['m', regra]], (_k, r) => `teto ${r.max}`)
    expect(() => enforceRateLimit([['m', regra]], (_k, r) => `teto ${r.max}`)).toThrow('teto 1')
  })
})
