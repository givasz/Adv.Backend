// Direitos do titular. Duas coisas não podem regredir aqui:
//
//   • exportar não pode entregar dado de OUTRA pessoa (quem denunciou o perfil);
//   • excluir tem que exigir a senha e tem que devolver o plano dos membros do
//     escritório antes de o escritório sumir junto com o dono.

import { describe, expect, it, vi } from 'vitest'
import { BadRequestException } from '@nestjs/common'
import { AccountService } from './account.service'
import { hashPassword } from '../auth/user-auth'

type Qualquer = Record<string, any>

const SENHA = 'ceramica-vento-38-azul'

function service(opts: { firms?: Qualquer[]; user?: Qualquer | null } = {}) {
  const calls: Qualquer = { profileUpdate: [], userDelete: [] }
  const prisma: Qualquer = {
    user: {
      findUnique: vi.fn(() =>
        Promise.resolve(
          opts.user === undefined
            ? {
                id: 'u1',
                email: 'marina@exemplo.com',
                password: hashPassword(SENHA),
                createdAt: new Date('2026-01-01'),
                profile: {
                  id: 'p1',
                  slug: 'marina-sales',
                  areas: [],
                  faqs: [],
                  socials: [],
                  auditLogs: [],
                  firmMembership: null,
                  reports: [{ reason: 'oab_invalid', status: 'open', createdAt: new Date() }],
                },
                firmsOwned: [],
                tickets: [],
                sessions: [],
              }
            : opts.user,
        ),
      ),
      delete: vi.fn((a: Qualquer) => (calls.userDelete.push(a), Promise.resolve({}))),
    },
    firm: { findMany: vi.fn(() => Promise.resolve(opts.firms ?? [])) },
    profile: { update: vi.fn((a: Qualquer) => (calls.profileUpdate.push(a), Promise.resolve({}))) },
    linkEvent: { count: vi.fn(() => Promise.resolve(42)) },
  }
  return { svc: new AccountService(prisma as any), prisma, calls }
}

describe('exportar', () => {
  it('entrega a conta, o perfil e as estatísticas', async () => {
    const { svc } = service()
    const d = await svc.exportData('u1')
    expect(d.conta.email).toBe('marina@exemplo.com')
    expect(d.perfil?.slug).toBe('marina-sales')
    expect(d.estatisticas.visitasAoPerfil).toBe(42)
  })

  it('NÃO entrega o contato de quem denunciou — é dado de outra pessoa', async () => {
    const { svc, prisma } = service()
    await svc.exportData('u1')
    const select = prisma.user.findUnique.mock.calls[0][0].select.profile.include.reports.select
    expect(select).toEqual({ reason: true, status: true, createdAt: true })
    expect(select.reporterEmail).toBeUndefined()
    expect(select.details).toBeUndefined()
  })

  it('o pacote não carrega a senha nem o hash dela', async () => {
    const { svc } = service()
    const texto = JSON.stringify(await svc.exportData('u1'))
    expect(texto).not.toContain(SENHA)
    expect(texto).not.toContain('scrypt$')
  })
})

describe('excluir', () => {
  it('exige a senha certa', async () => {
    const { svc, calls } = service()
    await expect(svc.deleteAccount('u1', 'senha-errada')).rejects.toThrow(BadRequestException)
    await expect(svc.deleteAccount('u1', '')).rejects.toThrow(BadRequestException)
    await expect(svc.deleteAccount('u1', undefined)).rejects.toThrow(BadRequestException)
    await expect(svc.deleteAccount('u1', { toString: () => SENHA })).rejects.toThrow(
      BadRequestException,
    )
    expect(calls.userDelete).toHaveLength(0) // nada foi apagado
  })

  it('com a senha certa, apaga a conta', async () => {
    const { svc, calls } = service()
    await expect(svc.deleteAccount('u1', SENHA)).resolves.toEqual({ excluida: true })
    expect(calls.userDelete[0]).toEqual({ where: { id: 'u1' } })
  })

  it('devolve o plano dos membros antes de o escritório sumir', async () => {
    const { svc, calls } = service({
      firms: [
        {
          id: 'f1',
          members: [
            { profileId: 'p-dono', previousPlan: null, profile: { userId: 'u1' } },
            { profileId: 'p-ana', previousPlan: 'pro', profile: { userId: 'u2' } },
            { profileId: 'p-caio', previousPlan: null, profile: { userId: 'u3' } },
          ],
        },
      ],
    })
    await svc.deleteAccount('u1', SENHA)

    // O dono não recebe devolução (o perfil dele some junto).
    expect(calls.profileUpdate).toHaveLength(2)
    expect(calls.profileUpdate[0]).toEqual({ where: { id: 'p-ana' }, data: { plan: 'pro' } })
    // Sem plano anterior registrado, volta para o Free — nunca fica no tier do
    // escritório que deixou de existir.
    expect(calls.profileUpdate[1]).toEqual({ where: { id: 'p-caio' }, data: { plan: 'free' } })
  })
})
