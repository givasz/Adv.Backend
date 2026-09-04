// O ACEITE DOS TERMOS no cadastro — a recusa que faz o registro existir.
//
// A caixa marcada na tela não prova nada: quem chama a rota direto nunca vê
// caixa nenhuma. É a recusa AQUI que sustenta a frase "toda conta desta base
// aceitou os Termos", que é o que se diz num processo.

import { describe, expect, it, vi } from 'vitest'
import { AuthService } from './auth.service'
import { TERMS_VERSION } from '../legal/termos'

type Qualquer = Record<string, any>

function service() {
  const criados: Qualquer[] = []
  const prisma: Qualquer = {
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn((a: Qualquer) => {
        criados.push(a.data)
        return Promise.resolve({
          id: 'u1',
          email: a.data.email,
          profile: { id: 'p1', name: '', plan: 'free' },
        })
      }),
      update: vi.fn((a: Qualquer) => (criados.push(a.data), Promise.resolve({}))),
    },
    firmInvite: { findFirst: vi.fn().mockResolvedValue(null) },
  }
  const sessions: Qualquer = {
    abrir: vi.fn().mockResolvedValue({ expiresAt: 1, csrfToken: 'c', remember: true }),
  }
  return { svc: new AuthService(prisma as any, sessions as any), criados }
}

const req = {} as any
const SENHA = 'Marina#Sales2026'

describe('cadastro sem aceite', () => {
  it('é recusado', async () => {
    const { svc } = service()
    await expect(svc.signup(req, 'a@b.com', SENHA, 'Marina', true)).rejects.toThrow(
      /aceitar os Termos/,
    )
  })

  it('não aceita "true" em texto nem 1 — declaração é gesto, não coincidência de tipo', async () => {
    const { svc } = service()
    for (const valor of ['true', 1, 'sim', {}]) {
      await expect(
        svc.signup(req, 'a@b.com', SENHA, 'Marina', true, { aceitou: valor, ip: '1.2.3.4' }),
      ).rejects.toThrow(/aceitar os Termos/)
    }
  })

  it('recusa ANTES de conferir a senha — não vira oráculo de regra de senha', async () => {
    const { svc, criados } = service()
    await expect(svc.signup(req, 'a@b.com', '123', 'Marina', true)).rejects.toThrow(
      /aceitar os Termos/,
    )
    expect(criados).toHaveLength(0)
  })
})

describe('cadastro com aceite', () => {
  it('grava data, versão e endereço na MESMA criação da conta', async () => {
    const { svc, criados } = service()
    await svc.signup(req, 'a@b.com', SENHA, 'Marina', true, {
      aceitou: true,
      ip: '198.51.100.7',
    })
    expect(criados).toHaveLength(1)
    expect(criados[0].termsAcceptedAt).toBeInstanceOf(Date)
    expect(criados[0].termsVersion).toBe(TERMS_VERSION)
    expect(criados[0].termsIp).toBe('198.51.100.7')
  })

  it('a sessão nasce sem pendência', async () => {
    const { svc } = service()
    const s = await svc.signup(req, 'a@b.com', SENHA, 'Marina', true, {
      aceitou: true,
      ip: '1.2.3.4',
    })
    expect(s.user.termsPending).toBe(false)
    expect(s.user.termsVersion).toBe(TERMS_VERSION)
  })
})

describe('reaceite de quem já tem conta', () => {
  it('carimba a versão do SERVIDOR, não a que o corpo pedir', async () => {
    const { svc, criados } = service()
    const r = await svc.aceitarTermos('u1', '203.0.113.9')
    expect(r.termsVersion).toBe(TERMS_VERSION)
    expect(criados[0].termsVersion).toBe(TERMS_VERSION)
    expect(criados[0].termsIp).toBe('203.0.113.9')
  })
})
