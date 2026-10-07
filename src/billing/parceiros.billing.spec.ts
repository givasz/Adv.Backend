// A cobrança e o Programa Advocme Parceiros — o encaixe.
//
// O que não pode regredir:
//   • o id do PAGAMENTO e o do WEBHOOK são coisas diferentes, e o programa usa o primeiro;
//   • só pagamento confirmado, validado e aplicado chega ao programa;
//   • falha, Pix e boleto aguardando, cartão em análise: nada chega;
//   • estorno chega ao programa mesmo quando a assinatura ignora o evento;
//   • um erro do programa nunca desfaz nem trava a cobrança.

import { describe, expect, it, vi } from 'vitest'
import { BillingService } from './billing.service'
import { lerEnvelope, marcaExterna, traduzir } from './asaas'

function webhook(o: { perfil?: Record<string, any>; partners?: any } = {}) {
  const vistos = new Set<string>()
  const perfil = {
    id: 'p1',
    plan: 'free',
    planStatus: 'active',
    currentPeriodEnd: null,
    graceUntil: null,
    planScheduled: null,
    billingEventAt: null,
    billingCustomerId: 'cus_1',
    billingSubscriptionId: 'sub_1',
    ...o.perfil,
  }
  const prisma: any = {
    billingEvent: {
      create: vi.fn(async (a: any) => {
        if (vistos.has(a.data.eventId)) throw Object.assign(new Error('unique'), { code: 'P2002' })
        vistos.add(a.data.eventId)
        return { id: `be-${a.data.eventId}` }
      }),
      update: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
      findUnique: vi.fn(async () => ({ applied: true, note: 'aplicado', createdAt: new Date() })),
    },
    profile: { findFirst: vi.fn(async () => perfil), update: vi.fn(async () => ({})) },
  }
  const profiles: any = { aplicarAssinaturaPorPerfil: vi.fn(async () => ({})) }
  const lock = { comPerfil: vi.fn(async (_id: string, f: () => Promise<unknown>) => f()) }
  const partners =
    o.partners ??
    ({ registrarConversao: vi.fn(async () => 'criada'), revogarPorPagamento: vi.fn(async () => 'revogada') } as any)
  return { svc: new BillingService(prisma, profiles, lock as any, partners), partners, profiles, prisma }
}

function doAsaas(event: string, extra: Record<string, unknown> = {}, id = `evt_${event}`) {
  const env = lerEnvelope({
    id,
    event,
    dateCreated: '2026-10-07 09:00:00',
    payment: {
      object: 'payment',
      id: 'pay_42',
      customer: 'cus_1',
      subscription: 'sub_1',
      value: 29,
      dueDate: '2026-10-07',
      externalReference: marcaExterna('p1', 'pro'),
      ...extra,
    },
  })
  return traduzir(env)!
}

describe('tradução do Asaas: pagamento ≠ webhook', () => {
  it('paymentId é o payment.id; id continua sendo o do evento', () => {
    const ev = doAsaas('PAYMENT_CONFIRMED')
    expect(ev.id).toBe('evt_PAYMENT_CONFIRMED')
    expect(ev.paymentId).toBe('pay_42')
  })

  it('CONFIRMED e RECEIVED do mesmo pagamento: ids de evento diferentes, o mesmo paymentId', () => {
    const a = doAsaas('PAYMENT_CONFIRMED')
    const b = doAsaas('PAYMENT_RECEIVED')
    expect(a.id).not.toBe(b.id)
    expect(a.paymentId).toBe(b.paymentId)
    expect([a.type, b.type]).toEqual(['payment_succeeded', 'payment_succeeded'])
  })

  it('estorno e chargeback levam o paymentId; evento de assinatura não leva', () => {
    expect(doAsaas('PAYMENT_REFUNDED')).toMatchObject({ type: 'payment_reversed', paymentId: 'pay_42' })
    expect(doAsaas('PAYMENT_CHARGEBACK_REQUESTED')).toMatchObject({ type: 'payment_reversed', paymentId: 'pay_42' })
    const sub = traduzir(
      lerEnvelope({ id: 'evt_s', event: 'SUBSCRIPTION_DELETED', dateCreated: '2026-10-07 09:00:00', subscription: { object: 'subscription', id: 'sub_1' } }),
    )!
    expect(sub.paymentId).toBeUndefined()
  })
})

describe('o webhook chama o programa só quando deve', () => {
  it('pagamento confirmado e aplicado → registrarConversao com o id do PAGAMENTO e do registro', async () => {
    const { svc, partners, profiles } = webhook()
    const ev = doAsaas('PAYMENT_CONFIRMED')
    await svc.processar(ev, JSON.stringify(ev))
    expect(profiles.aplicarAssinaturaPorPerfil).toHaveBeenCalledTimes(1)
    expect(partners.registrarConversao).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: 'p1', plan: 'pro', amount: 29, paymentId: 'pay_42', billingEventId: 'be-evt_PAYMENT_CONFIRMED' }),
    )
  })

  it('o mesmo evento entregue duas vezes chega ao programa uma vez só', async () => {
    const { svc, partners } = webhook()
    const ev = doAsaas('PAYMENT_CONFIRMED')
    await svc.processar(ev, JSON.stringify(ev))
    expect(await svc.processar(ev, JSON.stringify(ev))).toMatchObject({ reason: 'repetido' })
    expect(partners.registrarConversao).toHaveBeenCalledTimes(1)
  })

  it('falha de pagamento (vencido, recusado) não chega ao programa', async () => {
    const { svc, partners } = webhook()
    for (const tipo of ['PAYMENT_OVERDUE', 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED']) {
      const ev = doAsaas(tipo)
      await svc.processar(ev, JSON.stringify(ev))
    }
    expect(partners.registrarConversao).not.toHaveBeenCalled()
  })

  it('valor divergente: a cobrança não aplica, e o programa não é chamado', async () => {
    const { svc, partners } = webhook()
    const ev = doAsaas('PAYMENT_CONFIRMED', { value: 1 })
    expect(await svc.processar(ev, JSON.stringify(ev))).toMatchObject({ reason: 'valor divergente do plano' })
    expect(partners.registrarConversao).not.toHaveBeenCalled()
  })

  it('evento fora de ordem não converte; estorno revoga mesmo fora de ordem', async () => {
    const { svc, partners } = webhook({ perfil: { billingEventAt: new Date('2026-10-08T00:00:00Z') } })
    const pago = doAsaas('PAYMENT_CONFIRMED')
    await svc.processar(pago, JSON.stringify(pago))
    expect(partners.registrarConversao).not.toHaveBeenCalled()
    const estorno = doAsaas('PAYMENT_REFUNDED')
    await svc.processar(estorno, JSON.stringify(estorno))
    expect(partners.revogarPorPagamento).toHaveBeenCalledWith('pay_42', expect.stringMatching(/estorno/))
  })

  it('um erro do programa não desfaz nem trava a cobrança', async () => {
    const partners = {
      registrarConversao: vi.fn(async () => Promise.reject(new Error('banco do programa fora'))),
      revogarPorPagamento: vi.fn(async () => Promise.reject(new Error('fora'))),
    }
    const { svc, profiles, prisma } = webhook({ partners })
    const ev = doAsaas('PAYMENT_CONFIRMED')
    expect(await svc.processar(ev, JSON.stringify(ev))).toMatchObject({ applied: true })
    expect(profiles.aplicarAssinaturaPorPerfil).toHaveBeenCalledTimes(1)
    expect(prisma.billingEvent.delete).not.toHaveBeenCalled()
    const estorno = doAsaas('PAYMENT_REFUNDED')
    expect(await svc.processar(estorno, JSON.stringify(estorno))).toMatchObject({ applied: true })
  })

  it('cobrança antiga continua funcionando sem o programa (serviço montado sem ele)', async () => {
    const { prisma, profiles } = webhook()
    const lock = { comPerfil: vi.fn(async (_id: string, f: () => Promise<unknown>) => f()) }
    const svc = new BillingService(prisma, profiles, lock as any)
    const ev = doAsaas('PAYMENT_CONFIRMED')
    expect(await svc.processar(ev, JSON.stringify(ev))).toMatchObject({ applied: true })
  })
})
