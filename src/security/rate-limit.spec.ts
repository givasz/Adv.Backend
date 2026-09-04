import { beforeEach, describe, expect, it } from 'vitest'
import { HttpException } from '@nestjs/common'
import {
  AI_RATE_RULES,
  AUTH_RATE_RULES,
  tetoGlobalPorHora,
  checkRateLimit,
  enforceRateLimit,
  resetRateLimits,
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

  it('o dia sem conta é mais curto que o dia com conta, e os dois cabem no global', () => {
    expect(AI_RATE_RULES.perIpDay.max).toBeLessThan(AI_RATE_RULES.perUserDay.max)
    expect(AI_RATE_RULES.perUserDay.max).toBeLessThan(AI_RATE_RULES.global.max)
    expect(AI_RATE_RULES.perIpDay.windowMs).toBe(24 * 60 * 60 * 1000)
  })
})
