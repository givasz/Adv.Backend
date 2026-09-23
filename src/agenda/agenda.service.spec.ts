import { describe, expect, it, vi } from 'vitest'
import { AgendaService } from './agenda.service'
import { bloqueiosDaAgenda } from './blocks'

const profile = {
  id: 'p1', userId: 'u1', slug: 'ana', plan: 'premium', planStatus: 'active',
  currentPeriodEnd: null, graceUntil: null, published: true, moderationStatus: 'active',
  moderationUntil: null, meetingInboxEnabled: true, schedulingMode: 'assistant',
  assistantDays: JSON.stringify([{ weekday: 1, times: ['09:00', '09:45', '10:30'] }]),
  assistantDurationMin: 45,
  triageEnabled: true,
  triageQuestions: JSON.stringify([{ id: 'q1', label: 'Qual assunto?' }]),
}

const nextMonday = () => {
  const d = new Date()
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

describe('agenda digital', () => {
  it('bloqueia horários sobrepostos, inclusive um slot que começa antes do compromisso', () => {
    const date = nextMonday()
    const result = bloqueiosDaAgenda([{ startsAt: `${date}T09:30`, durationMin: 60 }], profile.assistantDays, 45)
    expect(result).toEqual([`${date}T09:00`, `${date}T09:45`])
  })

  it('aceita pedido no Max com consentimento e não retorna os dados do visitante no POST', async () => {
    const create = vi.fn(async () => ({ id: 'r1' }))
    const prisma = { profile: { findFirst: vi.fn(async () => profile) }, meetingRequest: { create } }
    const service = new AgendaService(prisma as any)
    await expect(service.solicitar('ana', {
      name: 'Maria', email: 'maria@exemplo.com', subject: 'Consulta sobre família', consent: true,
      triage: [
        { id: 'q1', pergunta: 'Pergunta adulterada', resposta: 'Família' },
        { id: 'q2', pergunta: 'Pergunta forjada', resposta: 'Resposta forjada' },
        { id: 'q1', pergunta: 'Qual assunto?', resposta: 'Resposta duplicada' },
      ],
    })).resolves.toEqual({ ok: true })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      profileId: 'p1', email: 'maria@exemplo.com', triage: JSON.stringify([{ id: 'q1', pergunta: 'Qual assunto?', resposta: 'Família' }]),
    }) }))
  })

  it('recusa pedido sem consentimento, contato válido ou plano Max ativo', async () => {
    const findFirst = vi.fn(async () => profile)
    const create = vi.fn()
    const service = new AgendaService({ profile: { findFirst }, meetingRequest: { create } } as any)
    await expect(service.solicitar('ana', { name: 'Maria', email: 'maria@exemplo.com', subject: 'Consulta' })).rejects.toThrow('Confirme')
    await expect(service.solicitar('ana', { name: 'Maria', whatsapp: '123456', subject: 'Consulta', consent: true })).rejects.toThrow('WhatsApp ou e-mail')
    findFirst.mockResolvedValueOnce({ ...profile, plan: 'pro' })
    await expect(service.solicitar('ana', { name: 'Maria', email: 'maria@exemplo.com', subject: 'Consulta', consent: true })).rejects.toThrow('não recebe')
    expect(create).not.toHaveBeenCalled()
  })

  it('não deixa uma conta decidir o pedido de outra', async () => {
    const service = new AgendaService({
      profile: { findUnique: vi.fn(async () => profile) },
      meetingRequest: { findFirst: vi.fn(async () => null), update: vi.fn() },
    } as any)
    await expect(service.decidir('u1', 'pedido-alheio', { status: 'confirmed', startsAt: `${nextMonday()}T09:00` })).rejects.toThrow('não encontrada')
  })

  it('confirma o pedido e cria o compromisso na mesma transação', async () => {
    const startsAt = `${nextMonday()}T09:00`
    const entry = { id: 'e1', profileId: 'p1', title: 'Reunião com Maria', startsAt, durationMin: 45 }
    const tx = {
      meetingRequest: { updateMany: vi.fn(async () => ({ count: 1 })), update: vi.fn(async () => ({})) },
      calendarEntry: { findMany: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([entry]), create: vi.fn(async () => entry) },
      profile: { update: vi.fn(async () => ({})) },
    }
    const prisma = {
      profile: { findUnique: vi.fn(async () => profile) },
      meetingRequest: { findFirst: vi.fn(async () => ({ id: 'r1', name: 'Maria', status: 'pending', calendarEntryId: null })) },
      $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
    }
    const result = await new AgendaService(prisma as any).decidir('u1', 'r1', { status: 'confirmed', startsAt, durationMin: 45 })
    expect(result).toEqual({ status: 'confirmed', entry })
    expect(tx.meetingRequest.updateMany).toHaveBeenCalledWith({ where: { id: 'r1', profileId: 'p1', status: 'pending', calendarEntryId: null }, data: { status: 'confirmed' } })
    expect(tx.calendarEntry.create).toHaveBeenCalledWith({ data: { profileId: 'p1', title: 'Reunião com Maria', startsAt, durationMin: 45 } })
    expect(tx.meetingRequest.update).toHaveBeenCalledWith({ where: { id: 'r1' }, data: { calendarEntryId: 'e1' } })
    expect(tx.profile.update).toHaveBeenCalledWith(expect.objectContaining({ data: { calendarBusy: JSON.stringify([startsAt]) } }))
  })

  it('repetir a confirmação devolve o compromisso já vinculado', async () => {
    const entry = { id: 'e1', startsAt: `${nextMonday()}T09:00`, durationMin: 45 }
    const transaction = vi.fn()
    const service = new AgendaService({
      profile: { findUnique: vi.fn(async () => profile) },
      meetingRequest: { findFirst: vi.fn(async () => ({ id: 'r1', name: 'Maria', status: 'confirmed', calendarEntryId: 'e1' })) },
      calendarEntry: { findFirst: vi.fn(async () => entry) },
      $transaction: transaction,
    } as any)
    await expect(service.decidir('u1', 'r1', { status: 'confirmed', startsAt: entry.startsAt })).resolves.toEqual({ status: 'confirmed', entry })
    expect(transaction).not.toHaveBeenCalled()
  })

  it('pagina cada estado separadamente e devolve contadores globais', async () => {
    const groupBy = vi.fn(async () => [
      { status: 'pending', _count: { _all: 23 } },
      { status: 'confirmed', _count: { _all: 14 } },
      { status: 'declined', _count: { _all: 2 } },
    ])
    const findMany = vi.fn(async () => [{ id: 'r21', triage: '[]' }])
    const service = new AgendaService({ profile: { findUnique: vi.fn(async () => profile) }, meetingRequest: { groupBy, findMany } } as any)
    const pending = await service.solicitacoes('u1', 3, 'pending')
    expect(pending).toMatchObject({ page: 3, pageSize: 10, total: 23, totalPages: 3, pendingCount: 23, counts: { pending: 23, confirmed: 14, declined: 2, all: 39 }, items: [{ id: 'r21', triage: [] }] })
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { profileId: 'p1', status: 'pending' }, take: 10, skip: 20 }))
    const confirmed = await service.solicitacoes('u1', 9, 'confirmed')
    expect(confirmed).toMatchObject({ page: 2, total: 14, totalPages: 2 })
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { profileId: 'p1', status: 'confirmed' }, skip: 10 }))
    const history = await service.solicitacoes('u1', 1)
    expect(history).toMatchObject({ total: 39, totalPages: 4 })
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { profileId: 'p1' }, skip: 0 }))
    await expect(service.solicitacoes('u1', 1, 'unknown')).rejects.toThrow('inválido')
  })

  it('não deixa dois compromissos se sobreporem', async () => {
    const date = nextMonday()
    const service = new AgendaService({
      profile: { findUnique: vi.fn(async () => profile) },
      calendarEntry: { findMany: vi.fn(async () => [{ id: 'e1', startsAt: `${date}T09:00`, durationMin: 60 }]), create: vi.fn() },
    } as any)
    await expect(service.criarEntrada('u1', { title: 'Retorno', startsAt: `${date}T09:30`, durationMin: 45 })).rejects.toThrow('Já existe')
  })
})

// PEDIDO FEITO NA PÁGINA DO ESCRITÓRIO.
//
// Duas naturezas, e a diferença é quem já tem dono: com advogado escolhido que
// recebe no painel, o pedido nasce endereçado a ele (e o escritório junto, porque
// entrou pela porta da sociedade); sem escolha, fica só do escritório e quem
// administra encaminha.
describe('solicitação pela página do escritório', () => {
  // Padrão: o escritório CENTRALIZA o atendimento (assistantRoute institucional).
  const firm = { id: 'f1', meetingInboxEnabled: true, assistantRoute: 'institutional' }
  const delega = { ...firm, assistantRoute: 'lawyer' }

  function servico(opts: { firm?: any; membro?: any } = {}) {
    const create = vi.fn(async (_args: any) => ({ id: 'r1' }))
    const membershipFindFirst = vi.fn(async (_args: any) => opts.membro ?? null)
    const prisma = {
      firm: { findUnique: vi.fn(async () => (opts.firm === undefined ? firm : opts.firm)) },
      firmMembership: { findFirst: membershipFindFirst },
      meetingRequest: { create },
    }
    return { svc: new AgendaService(prisma as any), create, membershipFindFirst, prisma }
  }

  const pedido = {
    name: 'Maria',
    email: 'maria@exemplo.com',
    subject: 'Conversa sobre a empresa',
    consent: true,
  }

  it('sem escolher advogado, o pedido fica na caixa da sociedade', async () => {
    const { svc, create } = servico()
    await expect(svc.solicitarNoEscritorio('andrade', pedido)).resolves.toEqual({ ok: true })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ profileId: null, firmId: 'f1' }),
      }),
    )
  })

  it('delegando ao advogado, o pedido nasce endereçado a ele E ao escritório', async () => {
    // O escritório continua vendo: foi pela página dele que o pedido entrou.
    const { svc, create } = servico({ firm: delega, membro: { profile } })
    await svc.solicitarNoEscritorio('andrade', { ...pedido, lawyerId: 'p1' })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ profileId: 'p1', firmId: 'f1' }),
      }),
    )
  })

  it('centralizando, a escolha do visitante NÃO endereça — mas fica guardada', async () => {
    // `assistantRoute` institucional é o escritório dizendo que os pedidos são
    // dele. A caixa do advogado não passa por cima disso; e perder com quem a
    // pessoa quis falar seria jogar fora a única coisa que ela disse sobre isso.
    const { svc, create } = servico({ membro: { profile } })
    await svc.solicitarNoEscritorio('andrade', { ...pedido, lawyerId: 'p1' })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ profileId: null, preferredLawyerId: 'p1' }),
      }),
    )
  })

  it('a preferência só guarda quem é MEMBRO ATIVO de verdade', async () => {
    const { svc, create } = servico({ membro: null })
    await svc.solicitarNoEscritorio('andrade', { ...pedido, lawyerId: 'p-estranho' })
    expect(create.mock.calls[0]![0].data.preferredLawyerId).toBe(null)
  })

  it('só aceita advogado ATIVO, deste escritório e com o perfil visível', async () => {
    // `lawyerId` vem do corpo, que é do visitante. Sem esta conferência, nome,
    // contato e assunto iriam para o painel de um perfil qualquer.
    const { svc, membershipFindFirst } = servico({ firm: delega, membro: { profile } })
    await svc.solicitarNoEscritorio('andrade', { ...pedido, lawyerId: 'p1' })
    const where = membershipFindFirst.mock.calls[0]![0].where
    expect(where).toMatchObject({ firmId: 'f1', status: 'active', profileId: 'p1' })
    expect(where.profile).toBeTruthy() // perfilVisivelAoPublico()
  })

  it('advogado de fora, ou que não recebe no painel, cai na caixa do escritório', async () => {
    const { svc, create } = servico({ firm: delega, membro: null })
    await svc.solicitarNoEscritorio('andrade', { ...pedido, lawyerId: 'p-estranho' })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ profileId: null }) }),
    )
  })

  it('escritório com a caixa desligada não recebe pedido nenhum', async () => {
    const { svc, create } = servico({ firm: { id: 'f1', meetingInboxEnabled: false, assistantRoute: 'institutional' } })
    await expect(svc.solicitarNoEscritorio('andrade', pedido)).rejects.toThrow('não recebe')
    expect(create).not.toHaveBeenCalled()
  })

  // Quem guarda o dado é quem ligou a própria caixa. Um pedido aceito SÓ porque o
  // advogado tem caixa é dele e de mais ninguém — o escritório que escolheu não
  // guardar nada não ganha uma cópia pelas costas (e, sem `firmId`, o advogado
  // volta a poder apagá-lo, porque o registro é dele).
  it('caixa só do ADVOGADO: o pedido é dele, sem firmId', async () => {
    const { svc, create } = servico({
      firm: { id: 'f1', meetingInboxEnabled: false, assistantRoute: 'lawyer' },
      membro: { profile },
    })
    await svc.solicitarNoEscritorio('andrade', { ...pedido, lawyerId: 'p1' })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ profileId: 'p1', firmId: null }),
      }),
    )
  })

  it('caixa dos DOIS: o pedido é do advogado e do escritório', async () => {
    const { svc, create } = servico({ firm: delega, membro: { profile } })
    await svc.solicitarNoEscritorio('andrade', { ...pedido, lawyerId: 'p1' })
    expect(create.mock.calls[0]![0].data).toMatchObject({ profileId: 'p1', firmId: 'f1' })
  })

  it('nenhuma caixa ligada: nem delegando o pedido entra', async () => {
    const { svc, create } = servico({
      firm: { id: 'f1', meetingInboxEnabled: false, assistantRoute: 'lawyer' },
      membro: null,
    })
    await expect(
      svc.solicitarNoEscritorio('andrade', { ...pedido, lawyerId: 'p1' }),
    ).rejects.toThrow('não recebe')
    expect(create).not.toHaveBeenCalled()
  })

  it('escritório que não existe responde igual ao que não recebe', async () => {
    const { svc } = servico({ firm: null })
    await expect(svc.solicitarNoEscritorio('sumiu', pedido)).rejects.toThrow('não recebe')
  })

  it('exige consentimento e contato, como a porta do perfil', async () => {
    const { svc, create } = servico()
    await expect(
      svc.solicitarNoEscritorio('andrade', { ...pedido, consent: false }),
    ).rejects.toThrow('Confirme')
    await expect(
      svc.solicitarNoEscritorio('andrade', { name: 'Maria', subject: 'Oi', consent: true }),
    ).rejects.toThrow('WhatsApp ou e-mail')
    expect(create).not.toHaveBeenCalled()
  })

  it('a triagem é conferida contra as perguntas DO ADVOGADO, nunca contra o corpo', async () => {
    // Vale mesmo com o atendimento centralizado: foram as perguntas DELE que o
    // visitante respondeu, ainda que quem vá responder seja o escritório.
    const { svc, create } = servico({ membro: { profile } })
    await svc.solicitarNoEscritorio('andrade', {
      ...pedido,
      lawyerId: 'p1',
      triage: [
        { id: 'q1', pergunta: 'Pergunta adulterada', resposta: 'Empresarial' },
        { id: 'q9', pergunta: 'Pergunta forjada', resposta: 'Resposta forjada' },
      ],
    })
    expect(create.mock.calls[0]![0].data.triage).toBe(
      JSON.stringify([{ id: 'q1', pergunta: 'Qual assunto?', resposta: 'Empresarial' }]),
    )
  })

  it('sem advogado escolhido não há triagem: a sociedade não tem perguntas próprias', async () => {
    const { svc, create } = servico()
    await svc.solicitarNoEscritorio('andrade', {
      ...pedido,
      triage: [{ id: 'q1', pergunta: 'Qual assunto?', resposta: 'Empresarial' }],
    })
    expect(create.mock.calls[0]![0].data.triage).toBe('[]')
  })
})

// O pedido que veio pela sociedade aparece nas DUAS caixas. Apagá-lo da do
// advogado sumiria também da de quem administra, que foi quem o encaminhou.
describe('o advogado não apaga pedido do escritório', () => {
  function servico(request: any) {
    const del = vi.fn()
    const prisma = {
      profile: { findUnique: vi.fn(async () => profile) },
      meetingRequest: { findFirst: vi.fn(async () => request), delete: del },
    }
    return { svc: new AgendaService(prisma as any), del }
  }

  it('recusa apagar o que tem firmId, e diz de quem é', async () => {
    const { svc, del } = servico({ id: 'r1', profileId: 'p1', firmId: 'f1' })
    await expect(svc.apagarSolicitacao('u1', 'r1')).rejects.toThrow('escritório')
    expect(del).not.toHaveBeenCalled()
  })

  it('pedido do próprio perfil continua sendo apagável', async () => {
    const { svc, del } = servico({ id: 'r1', profileId: 'p1', firmId: null })
    await expect(svc.apagarSolicitacao('u1', 'r1')).resolves.toEqual({ ok: true })
    expect(del).toHaveBeenCalled()
  })
})
