// Os atributos do cookie são a metade invisível da segurança da sessão: é neles
// que mora "o JavaScript não lê", "só viaja em https" e "outro site não usa".
// Erra-se aqui em silêncio — o login continua funcionando e a proteção some.

import { afterEach, describe, expect, it } from 'vitest'
import {
  cookieAttrs,
  cookieName,
  expiredCookie,
  mesmoSite,
  parseCookies,
  readCookie,
  serializeCookie,
  siteDe,
  SESSION_COOKIE,
} from './cookies'

const limpar = () => {
  delete process.env.AUTH_COOKIE_SAMESITE
  delete process.env.AUTH_COOKIE_DOMAIN
  delete process.env.AUTH_COOKIE_SECURE
}
afterEach(limpar)

describe('leitura', () => {
  it('separa os pares e ignora lixo', () => {
    expect(parseCookies('a=1; b=dois;  c ')).toEqual({ a: '1', b: 'dois' })
    expect(parseCookies(undefined)).toEqual({})
  })

  it('acha o cookie com e sem o prefixo __Host-', () => {
    expect(readCookie('advocme_session=abc', SESSION_COOKIE)).toBe('abc')
    expect(readCookie('__Host-advocme_session=abc', SESSION_COOKIE)).toBe('abc')
  })
})

describe('escrita', () => {
  const base = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/' }

  it('marca HttpOnly, Secure e SameSite', () => {
    const linha = serializeCookie(SESSION_COOKIE, 'v', base)
    expect(linha).toContain('HttpOnly')
    expect(linha).toContain('Secure')
    expect(linha).toContain('SameSite=Lax')
  })

  it('sem Max-Age o cookie morre com a janela; com ele, sobrevive', () => {
    expect(serializeCookie(SESSION_COOKIE, 'v', base)).not.toContain('Max-Age')
    expect(serializeCookie(SESSION_COOKIE, 'v', { ...base, maxAgeMs: 60_000 })).toContain(
      'Max-Age=60',
    )
  })

  it('usa __Host- quando pode (Secure, sem Domain) e o nome simples quando não', () => {
    expect(cookieName(SESSION_COOKIE, base)).toBe('__Host-advocme_session')
    expect(cookieName(SESSION_COOKIE, { ...base, domain: '.advoc.me' })).toBe('advocme_session')
    expect(cookieName(SESSION_COOKIE, { ...base, secure: false })).toBe('advocme_session')
  })

  it('apagar repete os atributos — senão o navegador cria um segundo cookie', () => {
    const apagar = expiredCookie(SESSION_COOKIE, { ...base, domain: '.advoc.me' })
    expect(apagar).toContain('Max-Age=0')
    expect(apagar).toContain('Domain=.advoc.me')
    expect(apagar).toContain('Path=/')
  })
})

describe('mesmo site', () => {
  it('reconhece subdomínios do mesmo domínio', () => {
    expect(siteDe('api.advoc.me')).toBe('advoc.me')
    expect(mesmoSite('https://advoc.me', 'api.advoc.me')).toBe(true)
  })

  it('não confunde dois .com.br diferentes', () => {
    expect(siteDe('api.escritorio.com.br')).toBe('escritorio.com.br')
    expect(mesmoSite('https://outro.com.br', 'api.escritorio.com.br')).toBe(false)
  })

  it('Netlify e a VPS são sites diferentes — é o deploy de hoje', () => {
    expect(mesmoSite('https://advocme.netlify.app', 'advocme.74.208.118.111.nip.io')).toBe(false)
  })
})

describe('atributos por requisição', () => {
  it('mesmo site → Lax (o navegador já barra o pedido de fora)', () => {
    const a = cookieAttrs({
      origin: 'https://advoc.me',
      host: 'api.advoc.me',
      proto: 'https',
      httpOnly: true,
    })
    expect(a.sameSite).toBe('lax')
    expect(a.secure).toBe(true)
  })

  it('sites diferentes → None, senão o cookie nem seria enviado', () => {
    const a = cookieAttrs({
      origin: 'https://advocme.netlify.app',
      host: 'advocme.74.208.118.111.nip.io',
      proto: 'https',
      httpOnly: true,
    })
    expect(a.sameSite).toBe('none')
    expect(a.secure).toBe(true)
  })

  it('None sem https cai para Lax — o navegador recusaria o cookie', () => {
    const a = cookieAttrs({
      origin: 'http://outro.local',
      host: 'api.local',
      proto: 'http',
      httpOnly: true,
    })
    expect(a.secure).toBe(false)
    expect(a.sameSite).toBe('lax')
  })

  it('a variável de ambiente tem a última palavra', () => {
    process.env.AUTH_COOKIE_SAMESITE = 'strict'
    const a = cookieAttrs({ origin: 'https://x.com', host: 'api.y.com', proto: 'https', httpOnly: true })
    expect(a.sameSite).toBe('strict')
  })
})
