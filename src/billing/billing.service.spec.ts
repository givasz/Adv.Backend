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
  falharAplicacaoUmaVez?: boolean
  erroAoCriarEvento?: Error
  eventoPendente?: boolean
  eventoPendenteDesde?: Date
}

function service(o: Opcoes = {}) {
  const vistos = new Set(o.jaVistos ?? [])
  let eventoPendente = o.eventoPendente === true
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
        if (o.erroAoCriarEvento) return Promise.reject(o.erroAoCriarEvento)
        const id = a.data.eventId
        if (eventoPendente) return Promise.reject(Object.assign(new Error('unique constraint'), { code: 'P2002' }))
        if (vistos.has(id)) return Promise.reject(Object.assign(new Error('unique constraint'), { code: 'P2002' }))
        vistos.add(id)
        calls.eventos.push(a.data)
        return Promise.resolve({ id: `be-${id}` })
      }),
      update: vi.fn((a: Qualquer) => (calls.eventos.push(a.data), Promise.resolve({}))),
      delete: vi.fn((a: Qualquer) => {
        const id = String(a.where.id).replace(/^be-/, '')
        vistos.delete(id)
        return Promise.resolve({})
      }),
      deleteMany: vi.fn(() => {
        eventoPendente = false
        return Promise.resolve({ count: 1 })
      }),
      findUnique: vi.fn(async () =>
        eventoPendente
          ? { applied: false, note: '', createdAt: o.eventoPendenteDesde ?? new Date() }
          : (o.erroAoCriarEvento as Qualquer | undefined)?.code === 'P2002'
            ? null
            : { applied: true, note: 'aplicado', createdAt: new Date() },
      ),
    },
    profile: {
      findFirst: vi.fn(() => Promise.resolve(perfil)),
      update: vi.fn((a: Qualquer) => (calls.profileUpdate.push(a.data), Promise.resolve({}))),
    },
  }
  let falharAplicacao = o.falharAplicacaoUmaVez === true
  const profiles: Qualquer = {
    aplicarAssinaturaPorPerfil: vi.fn((profileId: string, patch: Qualquer, motivo: string) => {
      if (falharAplicacao) {
        falharAplicacao = false
        return Promise.reject(new Error('falha transitória ao aplicar'))
      }
      calls.assinatura.push({ profileId, patch, motivo })
      return Promise.resolve({})
    }),
  }
  const lock = { comPerfil: vi.fn(async (_id: string, acao: () => Promise<unknown>) => acao()) }
  return { svc: new BillingService(prisma as any, profiles as any, lock as any), calls, prisma, profiles }
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

describe('dono do evento', () => {
  it('a referência nossa (o perfil) vem antes da assinatura, do cliente e do e-mail', async () => {
    const { svc, prisma } = service()
    const { json, corpo } = evento({ id: 'evt_ref', profileId: 'p1', email: 'alguem@exemplo.adv.br' })
    await svc.processar(json, corpo)
    // O e-mail é o elo fraco: com a referência presente, a primeira consulta já é
    // pelo id do perfil, e o e-mail nem chega a ser olhado.
    expect(prisma.profile.findFirst.mock.calls[0][0].where).toEqual({ id: 'p1' })
    expect(prisma.profile.findFirst).toHaveBeenCalledTimes(2)
    expect(prisma.profile.findFirst.mock.calls[1][0].where).toEqual({ id: 'p1' })
  })
})

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

  it('erro de banco ao registrar não é escondido como evento repetido', async () => {
    const { svc } = service({ erroAoCriarEvento: new Error('banco indisponível') })
    const { json, corpo } = evento({})

    await expect(svc.processar(json, corpo)).rejects.toThrow('banco indisponível')
  })

  it('P2002 de outra chave não é confundido com eventId repetido', async () => {
    const erro = Object.assign(new Error('outra chave única'), { code: 'P2002' })
    const { svc } = service({ erroAoCriarEvento: erro })
    const { json, corpo } = evento({})

    await expect(svc.processar(json, corpo)).rejects.toThrow('outra chave única')
  })

  it('entrega concorrente não confirma como concluído um evento que ainda está processando', async () => {
    const { svc } = service({ eventoPendente: true })
    const { json, corpo } = evento({})

    await expect(svc.processar(json, corpo)).rejects.toThrow(/processamento/i)
  })

  it('libera evento abandonado por processo interrompido para a próxima retentativa', async () => {
    const { svc } = service({
      eventoPendente: true,
      eventoPendenteDesde: new Date(Date.now() - 11 * 60 * 1000),
    })
    const { json, corpo } = evento({})

    await expect(svc.processar(json, corpo)).rejects.toThrow(/retentativa/i)
    await expect(svc.processar(json, corpo)).resolves.toMatchObject({ applied: true })
  })

  it('falha transitória não consome o evento: a repetição consegue aplicá-lo', async () => {
    const { svc, calls } = service({ falharAplicacaoUmaVez: true })
    const { json, corpo } = evento({})

    await expect(svc.processar(json, corpo)).rejects.toThrow('falha transitória')
    const repeticao = await svc.processar(json, corpo)

    expect(repeticao.applied).toBe(true)
    expect(calls.assinatura).toHaveLength(1)
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

  it('evento de assinatura antiga não altera a assinatura atual do perfil', async () => {
    const { svc, calls } = service({
      perfil: {
        id: 'p1',
        plan: 'premium',
        planStatus: 'active',
        currentPeriodEnd: dias(30),
        billingEventAt: null,
        billingCustomerId: 'cus_1',
        billingSubscriptionId: 'sub_atual',
      },
    })
    const { json, corpo } = evento({
      id: 'evt_sub_antiga',
      type: 'subscription_canceled',
      profileId: 'p1',
      subscriptionId: 'sub_antiga',
    })

    const r = await svc.processar(json, corpo)

    expect(r).toMatchObject({ applied: false })
    expect(r.reason).toMatch(/assinatura diferente/i)
    expect(calls.assinatura).toHaveLength(0)
  })

  it('evento de outro cliente não é aceito só porque cita o id do perfil', async () => {
    const { svc, calls } = service({
      perfil: {
        id: 'p1',
        plan: 'premium',
        planStatus: 'active',
        billingEventAt: null,
        billingCustomerId: 'cus_atual',
        billingSubscriptionId: null,
      },
    })
    const { json, corpo } = evento({
      id: 'evt_cliente_antigo',
      profileId: 'p1',
      subscriptionId: undefined,
      customerId: 'cus_antigo',
    })

    const r = await svc.processar(json, corpo)

    expect(r.applied).toBe(false)
    expect(r.reason).toMatch(/cliente diferente/i)
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

  it('pagamento do Asaas com valor diferente do plano não libera acesso', async () => {
    const { svc, calls } = service()
    const { json, corpo } = evento({ provider: 'asaas', plan: 'premium', amount: 1 })

    const r = await svc.processar(json, corpo)

    expect(r.applied).toBe(false)
    expect(r.reason).toMatch(/valor divergente/i)
    expect(calls.assinatura).toHaveLength(0)
  })

  it('pagamento falhado abre carência SEM rebaixar', async () => {
    const { svc, calls } = service()
    const { json, corpo } = evento({ type: 'payment_failed' })
    await svc.processar(json, corpo)
    expect(calls.assinatura[0].patch.planStatus).toBe('past_due')
    expect(calls.assinatura[0].patch.plan).toBeUndefined()
  })

  it('estorno integral encerra imediatamente o período que o pagamento tinha aberto', async () => {
    const { svc, calls } = service()
    const { json, corpo } = evento({ type: 'payment_reversed' })

    await svc.processar(json, corpo)

    expect(calls.assinatura[0].patch).toMatchObject({
      planStatus: 'canceled',
      graceUntil: null,
      planScheduled: null,
    })
    expect(calls.assinatura[0].patch.currentPeriodEnd).toEqual(HOJE)
  })

  it('cancelamento respeita o mês já pago', async () => {
    const { svc, calls } = service()
    const { json, corpo } = evento({ type: 'subscription_canceled', currentPeriodEnd: dias(9).toISOString() })
    await svc.processar(json, corpo)
    expect(calls.assinatura[0].patch.planStatus).toBe('canceled')
    expect(calls.assinatura[0].patch.currentPeriodEnd).toEqual(dias(9))
  })

  it('cancelamento feito AQUI (com devolução) não é estendido pelo aviso do provedor', async () => {
    // Arrependimento: o valor voltou e o plano terminou agora. O aviso de
    // assinatura apagada chega depois com a data da próxima cobrança — que não
    // pode devolver um mês a quem acabou de receber o dinheiro de volta.
    const terminouAgora = new Date('2026-09-30T15:00:00.000Z')
    const { svc, calls } = service({
      perfil: {
        id: 'p1',
        plan: 'premium',
        planStatus: 'canceled',
        currentPeriodEnd: terminouAgora,
        graceUntil: null,
        planScheduled: null,
        billingEventAt: null,
      },
    })
    const { json, corpo } = evento({ type: 'subscription_canceled', currentPeriodEnd: dias(30).toISOString() })
    await svc.processar(json, corpo)
    expect(calls.assinatura[0].patch.currentPeriodEnd).toEqual(terminouAgora)
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

  it('cancelamento atrasado não religa no perfil uma assinatura já apagada', async () => {
    const { svc, calls } = service({
      perfil: {
        id: 'p1',
        plan: 'free',
        planStatus: 'active',
        billingCustomerId: 'cus_9',
        billingSubscriptionId: null,
        billingEventAt: null,
      },
    })
    const { json, corpo } = evento({
      id: 'evt_cancelada',
      type: 'subscription_canceled',
      customerId: 'cus_9',
      subscriptionId: 'sub_apagada',
    })

    await svc.processar(json, corpo)

    expect(calls.profileUpdate[0]).not.toHaveProperty('billingSubscriptionId')
  })

  it('não aceita nem sobrescreve identificador de outra assinatura', async () => {
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
    const r = await svc.processar(json, corpo)
    expect(r.applied).toBe(false)
    expect(calls.profileUpdate).toHaveLength(0)
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
