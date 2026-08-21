// O boot em produção não pode aceitar os segredos de desenvolvimento: com eles no
// ar, qualquer pessoa que leia o repositório assina o próprio token de sessão.
// Estes testes existem para que ninguém "simplifique" isso de volta.

import { afterEach, describe, expect, it, vi } from 'vitest'

const ORIGINAL = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL }
  vi.resetModules()
})

async function carregar(env: Record<string, string | undefined>) {
  process.env = { ...ORIGINAL, ...env }
  vi.resetModules()
  return await import('./config')
}

const FORTE = 'H7qv3ZP0mKxL9sT2bNwR8cYf4jUeA1dG'

describe('assertSecureConfig em produção', () => {
  it('derruba o boot quando os segredos são os de desenvolvimento', async () => {
    const { assertSecureConfig } = await carregar({
      NODE_ENV: 'production',
      AUTH_SESSION_SECRET: 'dev-user-secret',
      ADMIN_SESSION_SECRET: 'troque-por-um-segredo-longo-aleatorio',
      ADMIN_PASSWORD: 'troque-esta-senha',
      FRONTEND_ORIGIN: 'https://advoc.me',
    })
    expect(() => assertSecureConfig()).toThrow(/AUTH_SESSION_SECRET/)
  })

  it('derruba o boot quando faltam variáveis', async () => {
    const { assertSecureConfig } = await carregar({
      NODE_ENV: 'production',
      AUTH_SESSION_SECRET: undefined,
      ADMIN_SESSION_SECRET: undefined,
      ADMIN_PASSWORD: undefined,
      ADMIN_TOKEN: undefined,
      FRONTEND_ORIGIN: undefined,
    })
    expect(() => assertSecureConfig()).toThrow(/não sobe/)
  })

  it('recusa segredo curto (adivinhável por força bruta)', async () => {
    const { assertSecureConfig } = await carregar({
      NODE_ENV: 'production',
      AUTH_SESSION_SECRET: 'curto123',
      ADMIN_SESSION_SECRET: FORTE,
      ADMIN_PASSWORD: 'senha-longa-de-verdade',
      FRONTEND_ORIGIN: 'https://advoc.me',
    })
    expect(() => assertSecureConfig()).toThrow(/AUTH_SESSION_SECRET/)
  })

  it('passa com segredos fortes', async () => {
    const { assertSecureConfig } = await carregar({
      NODE_ENV: 'production',
      AUTH_SESSION_SECRET: FORTE,
      ADMIN_SESSION_SECRET: `${FORTE}x`,
      ADMIN_PASSWORD: 'uma-senha-bem-longa-aqui',
      ADMIN_TOKEN: undefined,
      FRONTEND_ORIGIN: 'https://advoc.me',
    })
    expect(() => assertSecureConfig()).not.toThrow()
  })

  it('fora de produção apenas avisa — o dev sobe sem .env', async () => {
    const { assertSecureConfig } = await carregar({
      NODE_ENV: 'development',
      AUTH_SESSION_SECRET: undefined,
      ADMIN_SESSION_SECRET: undefined,
      ADMIN_PASSWORD: undefined,
      FRONTEND_ORIGIN: undefined,
    })
    const avisos: string[] = []
    expect(() => assertSecureConfig((m) => avisos.push(m))).not.toThrow()
    expect(avisos.join()).toMatch(/desenvolvimento/)
  })
})

describe('requireSecret', () => {
  it('em produção recusa valor conhecido em vez de assinar com ele', async () => {
    const { requireSecret } = await carregar({ NODE_ENV: 'production' })
    expect(() => requireSecret(['dev-admin-secret'], 'x')).toThrow(/Segredo/)
    expect(() => requireSecret([undefined, ''], 'x')).toThrow(/Segredo/)
    expect(requireSecret([undefined, FORTE], 'x')).toBe(FORTE)
  })

  it('em desenvolvimento respeita o .env local — senão o login local quebra', async () => {
    const { requireSecret } = await carregar({ NODE_ENV: 'development' })
    expect(requireSecret(['dev-admin-123'], 'outro')).toBe('dev-admin-123')
    expect(requireSecret([undefined], 'padrao-dev')).toBe('padrao-dev')
  })
})
