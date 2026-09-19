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
