import { describe, expect, it } from 'vitest'
import {
  CORREIO_NA_POLITICA_DESDE,
  configDoCorreio,
  politicaDeclaraCorreio,
  remetenteValido,
  urlDoSite,
} from './config'

const PROD_COMPLETO = {
  NODE_ENV: 'production',
  RESEND_API_KEY: 're_teste',
  MAIL_FROM: 'advoc.me <avisos@advoc.me>',
  SITE_URL: 'https://advoc.me',
}

describe('quando o correio liga', () => {
  it('desenvolvimento sem chave: as mensagens saem no console', () => {
    const c = configDoCorreio({ NODE_ENV: 'development' })
    expect(c.modo).toBe('console')
    expect(c.ativo).toBe(true)
  })

  it('produção sem chave: desligado — e nunca cai para o console', () => {
    const c = configDoCorreio({ NODE_ENV: 'production', FRONTEND_ORIGIN: 'https://advoc.me' })
    expect(c.modo).toBe('desligado')
    expect(c.ativo).toBe(false)
  })

  it('produção sem remetente válido: desligado', () => {
    const c = configDoCorreio({ ...PROD_COMPLETO, MAIL_FROM: '' })
    expect(c.modo).toBe('desligado')
    expect(c.aviso).toMatch(/MAIL_FROM/)
  })

  it('produção com tudo, mas a Política calada sobre o provedor: desligado, e diz por quê', () => {
    if (CORREIO_NA_POLITICA_DESDE !== null) return
    const c = configDoCorreio(PROD_COMPLETO)
    expect(c.modo).toBe('desligado')
    expect(c.aviso).toMatch(/Política de Privacidade/)
  })

  it('produção com a Política em dia: liga, e só com https', () => {
    if (CORREIO_NA_POLITICA_DESDE === null) return
    expect(configDoCorreio(PROD_COMPLETO).modo).toBe('resend')
    expect(configDoCorreio({ ...PROD_COMPLETO, SITE_URL: 'http://advoc.me' }).modo).toBe('desligado')
  })

  it('desenvolvimento com chave e sem remetente: usa o resend.dev e avisa do limite', () => {
    const c = configDoCorreio({ NODE_ENV: 'development', RESEND_API_KEY: 're_teste' })
    expect(c.modo).toBe('resend')
    expect(c.remetente).toContain('@resend.dev')
    expect(c.aviso).toMatch(/dono da conta/)
  })

  it('a Política declara a partir da versão que diz, e não antes', () => {
    expect(politicaDeclaraCorreio('2026-09-12', '2026-09-12')).toBe(true)
    expect(politicaDeclaraCorreio('2026-10-01', '2026-09-12')).toBe(true)
    expect(politicaDeclaraCorreio('2026-09-04', '2026-09-12')).toBe(false)
    expect(politicaDeclaraCorreio('2026-09-04', null)).toBe(false)
  })

  it('teto diário: 100 por padrão, e o do .env quando é um número', () => {
    expect(configDoCorreio({ NODE_ENV: 'development' }).tetoDiario).toBe(100)
    expect(configDoCorreio({ NODE_ENV: 'development', MAIL_TETO_DIA: '3000' }).tetoDiario).toBe(3000)
    expect(configDoCorreio({ NODE_ENV: 'development', MAIL_TETO_DIA: 'muito' }).tetoDiario).toBe(100)
  })
})

describe('o endereço dos links', () => {
  it('é só origem — caminho nenhum entra — e SITE_URL vence', () => {
    expect(urlDoSite({ SITE_URL: 'https://advoc.me/qualquer/coisa?x=1' })).toBe('https://advoc.me')
    expect(urlDoSite({ SITE_URL: 'https://advoc.me', FRONTEND_ORIGIN: 'https://outro.test' })).toBe('https://advoc.me')
  })

  it('sem SITE_URL, a primeira origem do CORS', () => {
    expect(urlDoSite({ FRONTEND_ORIGIN: 'https://a.test, https://b.test' })).toBe('https://a.test')
  })

  it('esquema que não é http(s) não vira link', () => {
    expect(urlDoSite({ SITE_URL: 'javascript:alert(1)' })).toBe('')
  })
})

describe('remetente', () => {
  it('aceita "Nome <e-mail>" e e-mail solto; recusa quebra de linha', () => {
    expect(remetenteValido('advoc.me <avisos@advoc.me>')).toBe(true)
    expect(remetenteValido('avisos@advoc.me')).toBe(true)
    expect(remetenteValido('advoc.me <avisos@advoc.me>\r\nBcc: todo@mundo.test')).toBe(false)
    expect(remetenteValido('advoc.me')).toBe(false)
    expect(remetenteValido('')).toBe(false)
  })
})
