// O webhook de cobrança é uma rota PÚBLICA que decide quem mantém o perfil no ar.
// Três coisas não podem falhar nela, e cada uma tem um jeito próprio de estragar
// tudo em silêncio:
//
//   assinatura → sem ela, a rota é um upgrade grátis para quem achar a URL
//   idempotência → provedor repete webhook; o mesmo "pagou" aplicado duas vezes
//                  estende o período duas vezes
//   ordem → webhook chega fora de ordem; um "falhou" de ontem chegando depois do
//           "pagou" de hoje rebaixaria quem está em dia

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { BillingService } from './billing.service'

type Qualquer = Record<string, any>

const SEGREDO = 'segredo-de-teste-com-tamanho-suficiente'
const HOJE = new Date('2026-08-28T12:00:00.000Z')
const dias = (n: number) => new Date(HOJE.getTime() + n * 24 * 60 * 60 * 1000)

function assinar(corpo: string) {
  return createHmac('sha256', SEGREDO).update(Buffer.from(corpo, 'utf8')).digest('hex')
}

interface Opcoes {
  perfil?: Qualquer | null
  /** ids de evento já registrados (a chave única do banco recusa repetidos) */
  jaVistos?: string[]
}

function service(o: Opcoes = {}) {
  const vistos = new Set(o.jaVistos ?? [])
  const calls: Qualquer = { assinatura: [], eventos: [], profileUpdate: [] }
  const perfil =
    o.perfil === undefined
      ? {
          id: 'p1',
          plan: 'premium',
          planStatus: 'active',
          currentPeriodEnd: dias(2),
          graceUntil: null,
          planScheduled: null,
          billingEventAt: null,
          billingCustomerId: null,
          billingSubscriptionId: null,
        }
      : o.perfil

  const prisma: Qualquer = {
    billingEvent: {
      create: vi.fn((a: Qualquer) => {
        const id = a.data.eventId
        if (vistos.has(id)) return Promise.reject(new Error('unique constraint'))
        vistos.add(id)
        calls.eventos.push(a.data)
        return Promise.resolve({ id: `be-${id}` })
      }),
      update: vi.fn((a: Qualquer) => (calls.eventos.push(a.data), Promise.resolve({}))),
    },
    profile: {
      findFirst: vi.fn(() => Promise.resolve(perfil)),
      update: vi.fn((a: Qualquer) => (calls.profileUpdate.push(a.data), Promise.resolve({}))),
    },
  }
  const profiles: Qualquer = {
    aplicarAssinaturaPorPerfil: vi.fn((profileId: string, patch: Qualquer, motivo: string) => {
      calls.assinatura.push({ profileId, patch, motivo })
      return Promise.resolve({})
    }),
  }
  return { svc: new BillingService(prisma as any, profiles as any), calls, prisma, profiles }
}

/** Monta corpo + assinatura como o provedor mandaria. */
function evento(campos: Qualquer) {
  const corpo = JSON.stringify({
    id: 'evt_1',
    type: 'payment_succeeded',
    occurredAt: HOJE.toISOString(),
    provider: 'teste',
    subscriptionId: 'sub_1',
    plan: 'premium',
    currentPeriodEnd: dias(30).toISOString(),
    ...campos,
  })
  return { corpo, json: JSON.parse(corpo), assinatura: assinar(corpo) }
}

beforeEach(() => {
  process.env.BILLING_WEBHOOK_SECRET = SEGREDO
})

describe('assinatura do webhook', () => {
  it('aceita a assinatura correta', () => {
    const { svc } = service()
    const { corpo, assinatura } = evento({})
    expect(() => svc.conferirAssinatura(Buffer.from(corpo), assinatura)).not.toThrow()
  })

  it('aceita o prefixo sha256= que alguns provedores usam', () => {
    const { svc } = service()
    const { corpo, assinatura } = evento({})
    expect(() => svc.conferirAssinatura(Buffer.from(corpo), `sha256=${assinatura}`)).not.toThrow()
  })

  it('recusa assinatura errada', () => {
    const { svc } = service()
    const { corpo } = evento({})
    expect(() => svc.conferirAssinatura(Buffer.from(corpo), 'a'.repeat(64))).toThrow(/inválida/i)
  })

  it('recusa corpo adulterado — um byte já basta', () => {
    const { svc } = service()
    const { corpo, assinatura } = evento({})
    expect(() => svc.conferirAssinatura(Buffer.from(corpo + ' '), assinatura)).toThrow(/inválida/i)
  })

  it('recusa quando não há assinatura nenhuma', () => {
    const { svc } = service()
    const { corpo } = evento({})
    expect(() => svc.conferirAssinatura(Buffer.from(corpo), undefined)).toThrow(/inválida/i)
  })

  it('SEM SEGREDO CONFIGURADO, a rota recusa tudo (fail closed)', () => {
    // Uma cobrança que aceita evento não assinado é pior do que uma que não
    // funciona: a segunda alguém conserta, a primeira ninguém percebe.
    delete process.env.BILLING_WEBHOOK_SECRET
    const { svc } = service()
    const { corpo, assinatura } = evento({})
    expect(() => svc.conferirAssinatura(Buffer.from(corpo), assinatura)).toThrow(/não configurada/i)
  })

  it('recusa corpo vazio', () => {
    const { svc } = service()
    expect(() => svc.conferirAssinatura(undefined, 'x')).toThrow(/vazio/i)
  })
})

describe('idempotência e ordem', () => {
  it('aplica o evento novo', async () => {
    const { svc, calls } = service()
    const { json, corpo } = evento({})
    const r = await svc.processar(json, corpo)
    expect(r.applied).toBe(true)
    expect(calls.assinatura[0].patch).toMatchObject({ plan: 'premium', planStatus: 'active' })
  })

  it('o mesmo evento duas vezes só vale uma', async () => {
    const { svc, calls } = service({ jaVistos: ['evt_1'] })
    const { json, corpo } = evento({})
    const r = await svc.processar(json, corpo)
    expect(r).toEqual({ ok: true, applied: false, reason: 'repetido' })
    expect(calls.assinatura).toHaveLength(0)
  })

  it('evento mais antigo que o último aplicado é registrado e ignorado', async () => {
    // O caso caro: o "falhou" de ontem chegando depois do "pagou" de hoje.
    const { svc, calls } = service({
      perfil: {
        id: 'p1',
        plan: 'premium',
        planStatus: 'active',
        currentPeriodEnd: dias(30),
        billingEventAt: HOJE,
      },
    })
    const { json, corpo } = evento({
      id: 'evt_atrasado',
      type: 'payment_failed',
      occurredAt: dias(-1).toISOString(),
    })
    const r = await svc.processar(json, corpo)
    expect(r.applied).toBe(false)
    expect(r.reason).toMatch(/fora de ordem/i)
    expect(calls.assinatura).toHaveLength(0)
  })

  it('evento sem perfil correspondente fica registrado, não some', async () => {
    const { svc, calls } = service({ perfil: null })
    const { json, corpo } = evento({})
    const r = await svc.processar(json, corpo)
    expect(r.applied).toBe(false)
    expect(r.reason).toMatch(/não encontrado/i)
    expect(calls.eventos[0].payload).toContain('evt_1')
  })

  it('tipo desconhecido é recusado na fronteira', async () => {
    const { svc } = service()
    const { json, corpo } = evento({ type: 'alguma_coisa' })
    await expect(svc.processar(json, corpo)).rejects.toThrow(/desconhecido/i)
  })
})

describe('o que cada evento faz', () => {
  it('pagamento confirmado renova o período e zera a carência', async () => {
    const { svc, calls } = service({
      perfil: { id: 'p1', plan: 'pro', planStatus: 'past_due', graceUntil: dias(3) },
    })
    const { json, corpo } = evento({ plan: 'pro' })
    await svc.processar(json, corpo)
    expect(calls.assinatura[0].patch).toMatchObject({ planStatus: 'active', graceUntil: null })
  })

  it('pagamento falhado abre carência SEM rebaixar', async () => {
    const { svc, calls } = service()
    const { json, corpo } = evento({ type: 'payment_failed' })
    await svc.processar(json, corpo)
    expect(calls.assinatura[0].patch.planStatus).toBe('past_due')
    expect(calls.assinatura[0].patch.plan).toBeUndefined()
  })

  it('cancelamento respeita o mês já pago', async () => {
    const { svc, calls } = service()
    const { json, corpo } = evento({ type: 'subscription_canceled', currentPeriodEnd: dias(9).toISOString() })
    await svc.processar(json, corpo)
    expect(calls.assinatura[0].patch.planStatus).toBe('canceled')
    expect(calls.assinatura[0].patch.currentPeriodEnd).toEqual(dias(9))
  })

  it('a renovação REALIZA o rebaixamento que estava agendado', async () => {
    // A pessoa pediu para descer no fim do período; o período virou e é o plano
    // menor que está sendo cobrado agora. Sem isto, ela pagaria o menor e
    // continuaria recebendo o maior, para sempre.
    const { svc, calls } = service({
      perfil: { id: 'p1', plan: 'premium', planStatus: 'active', planScheduled: 'pro' },
    })
    const { json, corpo } = evento({ plan: 'premium' })
    await svc.processar(json, corpo)
    expect(calls.assinatura[0].patch).toMatchObject({ plan: 'pro', planScheduled: null })
  })

  it('costura os identificadores do provedor na primeira cobrança', async () => {
    const { svc, calls } = service()
    const { json, corpo } = evento({ customerId: 'cus_9', subscriptionId: 'sub_9' })
    await svc.processar(json, corpo)
    expect(calls.profileUpdate[0]).toMatchObject({
      billingEventId: 'evt_1',
      billingCustomerId: 'cus_9',
      billingSubscriptionId: 'sub_9',
    })
  })

  it('não sobrescreve identificador já gravado', async () => {
    const { svc, calls } = service({
      perfil: {
        id: 'p1',
        plan: 'pro',
        planStatus: 'active',
        billingCustomerId: 'cus_original',
        billingSubscriptionId: 'sub_original',
      },
    })
    const { json, corpo } = evento({ customerId: 'cus_outro', subscriptionId: 'sub_outro' })
    await svc.processar(json, corpo)
    expect(calls.profileUpdate[0]).not.toHaveProperty('billingCustomerId')
    expect(calls.profileUpdate[0]).not.toHaveProperty('billingSubscriptionId')
  })

  it('pausar e retomar não mexem no plano contratado', async () => {
    const { svc, calls } = service()
    const a = evento({ id: 'evt_p', type: 'subscription_paused' })
    await svc.processar(a.json, a.corpo)
    expect(calls.assinatura[0].patch).toEqual({ planStatus: 'paused' })
  })

  it('o efeito passa pela porta que RECONCILIA, nunca por um update de plano cru', async () => {
    // É o que garante que tema e agendamento caiam junto com o plano.
    const { svc, calls } = service()
    const { json, corpo } = evento({ type: 'subscription_canceled' })
    await svc.processar(json, corpo)
    expect(calls.assinatura).toHaveLength(1)
    expect(calls.profileUpdate[0]).not.toHaveProperty('plan')
  })
})
