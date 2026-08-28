// Regras de sociedade que NÃO podem regredir. O banco de produção é Postgres e não
// existe aqui, então o Prisma é dublê: o que se testa são as decisões do serviço —
// quem pode entrar, quem pode sair, e o que acontece com o perfil e o plano de quem
// sai. Foi exatamente aí que a versão anterior errava (apagava o perfil).

import { describe, expect, it, vi } from 'vitest'
import { FirmsService } from './firms.service'

type Qualquer = Record<string, any>

// Prisma dublê: só os caminhos que os testes percorrem. `opts` ajusta o que o banco
// responde; `calls` guarda o que o serviço mandou gravar.
function service(opts: { membership?: Qualquer; convidado?: Qualquer } = {}) {
  const calls: Qualquer = {
    profileUpdate: [],
    membershipCreate: [],
    membershipUpdate: [],
    membershipDelete: [],
    // Mudança de plano NÃO é mais um profile.update cru: passa pela porta que
    // reconcilia tema, agendamento e endereço (ProfilesService). O que se testa
    // aqui é que o escritório chama essa porta com o plano certo.
    assinatura: [],
  }
  const prisma: Qualquer = {
    firm: {
      findFirst: vi.fn().mockResolvedValue({ id: 'firm1' }),
      findUnique: vi.fn().mockResolvedValue({ id: 'firm1', slug: 'x', members: [], invites: [] }),
      update: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({ id: 'firm1' }),
    },
    firmMembership: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(opts.membership ?? null),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn((a: Qualquer) => (calls.membershipCreate.push(a), Promise.resolve({}))),
      update: vi.fn((a: Qualquer) => (calls.membershipUpdate.push(a), Promise.resolve({}))),
      delete: vi.fn((a: Qualquer) => (calls.membershipDelete.push(a), Promise.resolve({}))),
    },
    firmInvite: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      upsert: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    profile: {
      update: vi.fn((a: Qualquer) => (calls.profileUpdate.push(a), Promise.resolve({}))),
      delete: vi.fn(),
    },
    user: { findUnique: vi.fn().mockResolvedValue(opts.convidado ?? null) },
    // O aceite roda numa transação: aqui basta executar as promessas recebidas.
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  }
  const profiles: Qualquer = {
    aplicarAssinaturaPorPerfil: vi.fn((profileId: string, patch: Qualquer, motivo: string) => {
      calls.assinatura.push({ profileId, patch, motivo })
      return Promise.resolve({})
    }),
  }
  return { svc: new FirmsService(prisma as any, profiles as any), prisma, calls, profiles }
}

describe('convite', () => {
  it('recusa e-mail inválido antes de tocar no banco', async () => {
    const { svc, prisma } = service()
    await expect(svc.invite('u1', 'nao-e-email')).rejects.toThrow(/e-mail válido/i)
    expect(prisma.user.findUnique).not.toHaveBeenCalled()
  })

  it('vincula ao perfil que o advogado JÁ tem — nunca cria um perfil novo', async () => {
    const { svc, prisma, calls } = service({
      convidado: { id: 'u2', profile: { id: 'p2', firmMembership: null } },
    })
    await svc.invite('u1', 'Socio@Exemplo.adv.br')
    expect(calls.membershipCreate[0].data).toMatchObject({
      firmId: 'firm1',
      profileId: 'p2',
      status: 'invited',
      role: 'member',
    })
    expect(prisma.firmInvite.upsert).not.toHaveBeenCalled()
  })

  it('sem conta ainda: guarda o convite pelo e-mail, em minúsculas', async () => {
    const { svc, prisma } = service()
    await svc.invite('u1', '  Novo@Exemplo.adv.br ')
    expect(prisma.firmInvite.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { firmId_email: { firmId: 'firm1', email: 'novo@exemplo.adv.br' } },
      }),
    )
  })

  it('barra quem já está em outro escritório (um advogado, uma sociedade)', async () => {
    const { svc } = service({
      convidado: { id: 'u2', profile: { id: 'p2', firmMembership: { firmId: 'outra' } } },
    })
    await expect(svc.invite('u1', 'socio@exemplo.adv.br')).rejects.toThrow(/outro escritório/i)
  })
})

describe('saída do escritório', () => {
  const ativo = {
    id: 'm1',
    firmId: 'firm1',
    role: 'member',
    status: 'active',
    profileId: 'p2',
    previousPlan: 'pro',
  }

  it('remove o VÍNCULO e nunca o perfil', async () => {
    const { svc, prisma, calls } = service({ membership: ativo })
    await svc.removeMember('u1', 'membership', 'm1')
    expect(calls.membershipDelete[0]).toEqual({ where: { id: 'm1' } })
    expect(prisma.profile.delete).not.toHaveBeenCalled()
  })

  it('devolve o plano individual que o advogado tinha antes de entrar', async () => {
    const { svc, calls } = service({ membership: ativo })
    await svc.removeMember('u1', 'membership', 'm1')
    expect(calls.assinatura[0].profileId).toBe('p2')
    expect(calls.assinatura[0].patch.plan).toBe('pro')
  })

  it('sem plano guardado, quem sai volta para o free', async () => {
    const { svc, calls } = service({ membership: { ...ativo, previousPlan: null } })
    await svc.removeMember('u1', 'membership', 'm1')
    expect(calls.assinatura[0].patch.plan).toBe('free')
  })

  it('quem sai não leva o relógio de cobrança do escritório junto', async () => {
    // Quem paga o escritório é o dono dele. Se o período pago do escritório
    // ficasse gravado no perfil de quem saiu, o advogado seguiria com plano de
    // graça até a data que OUTRA pessoa pagou.
    const { svc, calls } = service({ membership: ativo })
    await svc.removeMember('u1', 'membership', 'm1')
    expect(calls.assinatura[0].patch).toMatchObject({
      planStatus: 'active',
      currentPeriodEnd: null,
      graceUntil: null,
      planScheduled: null,
    })
  })

  it('a devolução passa pela porta que RECONCILIA, nunca por um update cru', async () => {
    // Enquanto era `profile.update({ data: { plan } })`, quem saía voltava ao Free
    // carregando tema do Max e botão de agendar ligados.
    const { svc, calls } = service({ membership: ativo })
    await svc.removeMember('u1', 'membership', 'm1')
    expect(calls.profileUpdate).toHaveLength(0)
    expect(calls.assinatura).toHaveLength(1)
  })

  it('quem nunca aceitou (convidado) sai sem mexer no plano', async () => {
    const { svc, calls } = service({
      membership: { ...ativo, status: 'invited', previousPlan: null },
    })
    await svc.removeMember('u1', 'membership', 'm1')
    expect(calls.profileUpdate).toHaveLength(0)
    expect(calls.assinatura).toHaveLength(0)
  })

  it('o dono não pode ser removido do próprio escritório', async () => {
    const { svc } = service({ membership: { ...ativo, role: 'owner' } })
    await expect(svc.removeMember('u1', 'membership', 'm1')).rejects.toThrow(/dono/i)
  })

  it('não deixa remover membro de OUTRO escritório', async () => {
    const { svc } = service({ membership: { ...ativo, firmId: 'outra' } })
    await expect(svc.removeMember('u1', 'membership', 'm1')).rejects.toThrow(/não encontrado/i)
  })
})

describe('aceite do convite', () => {
  const convite = {
    id: 'm1',
    status: 'invited',
    previousPlan: null,
    profileId: 'p2',
    firmId: 'firm1',
    profile: { userId: 'u2', plan: 'pro' },
    firm: { id: 'firm1', plan: 'premium' },
  }

  it('só o dono do convite pode aceitar', async () => {
    const { svc } = service({ membership: convite })
    await expect(svc.acceptInvite('outro', 'm1')).rejects.toThrow(/não é seu/i)
  })

  it('guarda o plano anterior e sobe o advogado para o tier do escritório', async () => {
    const { svc, calls } = service({ membership: convite })
    await svc.acceptInvite('u2', 'm1')
    expect(calls.membershipUpdate[0]).toEqual({
      where: { id: 'm1' },
      data: { status: 'active', previousPlan: 'pro' },
    })
    // A subida também passa pela porta que reconcilia: entrar no escritório é
    // upgrade, e upgrade tira o número automático do endereço do Free.
    expect(calls.profileUpdate).toHaveLength(0)
    expect(calls.assinatura[0]).toMatchObject({
      profileId: 'p2',
      patch: { plan: 'premium', planStatus: 'active' },
    })
  })

  it('recusar apaga o vínculo e deixa o perfil intacto', async () => {
    const { svc, prisma, calls } = service({ membership: convite })
    await svc.declineInvite('u2', 'm1')
    expect(calls.membershipDelete[0]).toEqual({ where: { id: 'm1' } })
    expect(calls.profileUpdate).toHaveLength(0)
    expect(prisma.profile.delete).not.toHaveBeenCalled()
  })
})
