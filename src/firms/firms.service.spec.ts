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
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: 'firm1', slug: 'x', members: [], invites: [], roster: [] }),
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
    // Advogados listados sem conta. O dublê precisa conhecer a tabela porque
    // syncSeats a consulta em toda entrada e saída — sem ela, nove testes que
    // não têm nada a ver com o assunto quebram com "count is not a function".
    firmRosterLawyer: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
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

// ADVOGADO LISTADO SEM CONTA.
//
// Montar a página exigia que cada advogado criasse conta e aceitasse convite
// ANTES de aparecer: um escritório de doze pessoas ficava com a página vazia
// esperando doze cadastros. Agora o escritório lista quem é do quadro, e a conta
// de cada um vem depois — se vier.
describe('advogado listado sem conta', () => {
  it('entra na lista com nome, OAB e área', async () => {
    const { svc, prisma } = service()
    await svc.addRosterLawyer('u1', {
      name: 'Marina Sales',
      oabNumber: 'OAB/SP 214.870',
      area: 'Direito de Família',
    })
    expect(prisma.firmRosterLawyer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          firmId: 'firm1',
          name: 'Marina Sales',
          oabNumber: 'OAB/SP 214.870',
          area: 'Direito de Família',
        }),
      }),
    )
  })

  it('exige nome — uma linha em branco no grid não é ninguém', async () => {
    const { svc } = service()
    await expect(svc.addRosterLawyer('u1', { name: '' })).rejects.toThrow(/nome/i)
    await expect(svc.addRosterLawyer('u1', { name: 'A' })).rejects.toThrow(/nome/i)
  })

  // O nome vai para uma página pública e passa pela MESMA checagem do resto do
  // produto — senão "Dr. Fulano, o melhor do estado" entra por esta porta.
  it('recusa nome com termo vedado pela OAB', async () => {
    const { svc } = service()
    await expect(
      svc.addRosterLawyer('u1', { name: 'Dr. João, o melhor advogado do estado' }),
    ).rejects.toThrow(/OAB|vedado/i)
  })

  it('corta texto gigante em vez de gravar um romance', async () => {
    const { svc, prisma } = service()
    await svc.addRosterLawyer('u1', {
      name: 'x'.repeat(500),
      oabNumber: 'y'.repeat(500),
      area: 'z'.repeat(500),
    })
    const d = prisma.firmRosterLawyer.create.mock.calls[0][0].data
    expect(d.name.length).toBeLessThanOrEqual(70)
    expect(d.oabNumber.length).toBeLessThanOrEqual(20)
    expect(d.area.length).toBeLessThanOrEqual(60)
  })
})

describe('associar e-mail dá autonomia ao listado', () => {
  it('cai no fluxo de convite que já existe, com o papel escolhido', async () => {
    const { svc, prisma } = service()
    prisma.firmRosterLawyer.findUnique.mockResolvedValue({ id: 'r1', firmId: 'firm1' })
    await svc.linkRosterLawyer('u1', 'r1', 'Marina@Exemplo.COM', 'admin')
    // e-mail em minúsculas, como no convite comum
    expect(prisma.firmInvite.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ email: 'marina@exemplo.com', role: 'admin' }),
      }),
    )
    // e a linha continua na lista, guardando o que foi pedido
    expect(prisma.firmRosterLawyer.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { email: 'marina@exemplo.com', role: 'admin' } }),
    )
  })

  it('papel desconhecido vira "member" — nunca admin por engano', async () => {
    const { svc, prisma } = service()
    prisma.firmRosterLawyer.findUnique.mockResolvedValue({ id: 'r1', firmId: 'firm1' })
    await svc.linkRosterLawyer('u1', 'r1', 'a@b.com', 'dono-de-tudo')
    expect(prisma.firmRosterLawyer.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: 'member' }) }),
    )
  })

  it('recusa e-mail inválido', async () => {
    const { svc, prisma } = service()
    prisma.firmRosterLawyer.findUnique.mockResolvedValue({ id: 'r1', firmId: 'firm1' })
    await expect(svc.linkRosterLawyer('u1', 'r1', 'nao-e-email', 'member')).rejects.toThrow(/e-mail/i)
  })

  // Um id de outro escritório não pode ser alcançado só por ser adivinhado.
  it('não alcança advogado de OUTRO escritório', async () => {
    const { svc, prisma } = service()
    prisma.firmRosterLawyer.findUnique.mockResolvedValue({ id: 'r1', firmId: 'outra-firma' })
    await expect(svc.linkRosterLawyer('u1', 'r1', 'a@b.com', 'member')).rejects.toThrow(
      /não encontrado/i,
    )
    await expect(svc.removeRosterLawyer('u1', 'r1')).rejects.toThrow(/não encontrado/i)
  })
})

describe('a mesma pessoa nunca aparece duas vezes', () => {
  it('convite de quem já está listado não vira linha própria', async () => {
    const { svc, prisma } = service()
    // Depois de associar o e-mail, existem DOIS registros para a mesma pessoa: a
    // linha do roster (com o nome) e o FirmInvite (com o endereço). Mostrar os
    // dois punha "Marina Sales" e "marina@..." lado a lado, sem nada dizendo que
    // são a mesma — quem representa os dois é a linha que tem o nome.
    prisma.firm.findUnique.mockResolvedValue({
      id: 'firm1',
      slug: 'x',
      seatsPurchased: 5,
      members: [],
      invites: [{ id: 'i1', email: 'marina@exemplo.com', role: 'admin' }],
      roster: [
        {
          id: 'r1',
          name: 'Marina Sales',
          email: 'marina@exemplo.com',
          role: 'admin',
          oabNumber: '',
          area: '',
        },
      ],
    })
    const view: Qualquer = await svc.getMine('u1')
    const nomes = view.members.map((m: Qualquer) => `${m.kind}:${m.name}`)
    expect(nomes).toEqual(['roster:Marina Sales'])
  })

  it('convite SEM linha listada continua aparecendo', async () => {
    const { svc, prisma } = service()
    prisma.firm.findUnique.mockResolvedValue({
      id: 'firm1',
      slug: 'x',
      seatsPurchased: 5,
      members: [],
      invites: [{ id: 'i1', email: 'outro@exemplo.com', role: 'member' }],
      roster: [],
    })
    const view: Qualquer = await svc.getMine('u1')
    expect(view.members.map((m: Qualquer) => m.kind)).toEqual(['invite'])
  })
})

// A página pública do escritório era a porta dos fundos da moderação.
//
// `GET /api/firms/:slug` não tem sessão e listava TODO membro ativo, sem olhar o
// perfil de cada um. Então um advogado restringido saía do ar em `/:slug` e
// continuava inteiro na página da sociedade — nome, foto, bio, OAB e WhatsApp —,
// e o rascunho de quem nunca publicou ia junto.
//
// O teste é sobre a CONSULTA, não sobre o resultado: sem banco, o que dá para
// provar é que a condição de visibilidade foi levada ao Prisma. É o bastante,
// porque o defeito era ela não existir.
describe('página pública do escritório', () => {
  function servicoPublico() {
    const prisma: Qualquer = {
      firm: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: 'firm1', slug: 'andrade-vieira', members: [], roster: [] }),
      },
    }
    return { svc: new FirmsService(prisma as any, {} as any), prisma }
  }

  it('só lista membro cujo perfil está publicado e não restringido', async () => {
    const { svc, prisma } = servicoPublico()
    await svc.getBySlug('andrade-vieira')
    const filtro = prisma.firm.findUnique.mock.calls[0][0].include.members.where
    expect(filtro.status).toBe('active')
    // A mesma regra da página de perfil, da foto e do sitemap.
    expect(filtro.profile.published).toBe(true)
    expect(filtro.profile.OR).toEqual([
      { moderationStatus: { not: 'restricted' } },
      { moderationUntil: { lte: expect.any(Date) } },
    ])
  })

  it('o EDITOR continua vendo todo mundo — inclusive quem está fora do ar', async () => {
    // Quem administra precisa enxergar o membro restrito ou por publicar; é o que
    // lhe permite cobrar a regularização em vez de ficar sem entender por que a
    // página tem um card a menos.
    const { svc, prisma } = servicoPublico()
    prisma.firm.findFirst = vi.fn().mockResolvedValue({ id: 'firm1' })
    prisma.firm.findUnique = vi.fn().mockResolvedValue({
      id: 'firm1',
      slug: 'andrade-vieira',
      members: [],
      invites: [],
      roster: [],
    })
    prisma.firmMembership = { count: vi.fn().mockResolvedValue(0) }
    prisma.firmInvite = { count: vi.fn().mockResolvedValue(0) }
    prisma.firmRosterLawyer = { count: vi.fn().mockResolvedValue(0) }
    await svc.getMine('u1')
    const filtro = prisma.firm.findUnique.mock.calls[0][0].include.members.where
    expect(filtro).toBeUndefined()
  })
})
