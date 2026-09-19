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
    await expect(service.decidir('u1', 'pedido-alheio', 'confirmed')).rejects.toThrow('não encontrada')
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
