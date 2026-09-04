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
  const calls: Qualquer = { profileUpdate: [], userDelete: [], assinatura: [] }
  const prisma: Qualquer = {
    user: {
      findUnique: vi.fn(async () =>
        opts.user === undefined
            ? {
                id: 'u1',
                email: 'marina@exemplo.com',
                password: await hashPassword(SENHA),
                createdAt: new Date('2026-01-01'),
                termsAcceptedAt: new Date('2026-01-01'),
                termsVersion: '2026-09-04',
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
      delete: vi.fn((a: Qualquer) => (calls.userDelete.push(a), Promise.resolve({}))),
    },
    firm: { findMany: vi.fn(() => Promise.resolve(opts.firms ?? [])) },
    profile: { update: vi.fn((a: Qualquer) => (calls.profileUpdate.push(a), Promise.resolve({}))) },
    linkEvent: { count: vi.fn(() => Promise.resolve(42)) },
    // Registro de acesso (Marco Civil, art. 15). Entra na exportação porque é
    // dado pessoal de quem pede — a LGPD dá direito de VER até o que guardamos
    // por obrigação legal e não podemos apagar a pedido.
    accessLog: {
      findMany: vi.fn(() =>
        Promise.resolve([
          {
            action: 'login',
            ip: '198.51.100.7',
            userAgent: 'Mozilla/5.0',
            createdAt: new Date('2026-09-01'),
          },
        ]),
      ),
    },
    // Histórico de cobrança: dado sobre a PESSOA, então entra na exportação.
    billingEvent: {
      findMany: vi.fn(() =>
        Promise.resolve([
          {
            type: 'payment_succeeded',
            occurredAt: new Date('2026-08-01'),
            applied: true,
            note: 'aplicado',
            provider: 'teste',
          },
        ]),
      ),
    },
  }
  // Devolver plano passa pela porta que reconcilia (ProfilesService), não por um
  // profile.update cru — ver releaseOwnedFirms.
  const profiles: Qualquer = {
    aplicarAssinaturaPorPerfil: vi.fn((profileId: string, patch: Qualquer, motivo: string) => {
      calls.assinatura.push({ profileId, patch, motivo })
      return Promise.resolve({})
    }),
  }
  return { svc: new AccountService(prisma as any, profiles as any), prisma, calls, profiles }
}

describe('exportar', () => {
  it('entrega o histórico de cobrança, sem o payload cru do provedor', async () => {
    // O histórico é dado da pessoa e é o que ela vai querer ver se discordar de
    // uma mudança de plano. O payload cru, não: ele é a cópia do que o provedor
    // mandou, guardada para depuração, e devolvê-lo exportaria identificadores
    // internos do provedor sem ganho nenhum para quem lê.
    const { svc } = service()
    const d: Record<string, any> = await svc.exportData('u1')
    expect(d.historicoDeCobranca).toHaveLength(1)
    expect(d.historicoDeCobranca[0]).not.toHaveProperty('payload')
    expect(JSON.stringify(d)).not.toMatch(/billingCustomerId":"cus/)
  })

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
    expect(calls.assinatura).toHaveLength(2)
    expect(calls.assinatura[0].profileId).toBe('p-ana')
    expect(calls.assinatura[0].patch.plan).toBe('pro')
    // Sem plano anterior registrado, volta para o Free — nunca fica no tier do
    // escritório que deixou de existir.
    expect(calls.assinatura[1].profileId).toBe('p-caio')
    expect(calls.assinatura[1].patch.plan).toBe('free')
    // E nunca por um update cru, que pularia a reconciliação de tema/agendamento.
    expect(calls.profileUpdate).toHaveLength(0)
  })
})
