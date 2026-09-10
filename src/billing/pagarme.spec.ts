// A tradução do webhook da Pagar.me é onde erro de integração mora.
//
// Ela não decide política nenhuma — mas entrega os dados com que a política
// decide. Um `subscriptionId` lido do lugar errado faz o evento não achar dono e
// a renovação simplesmente não acontecer; uma data lida errado rebaixa quem
// pagou. As duas falhas são silenciosas: ninguém abre um chamado dizendo "meu
// webhook casou com o perfil errado", a pessoa só descobre que perdeu o plano.

import { afterEach, describe, expect, it } from 'vitest'
import { UnauthorizedException } from '@nestjs/common'
import { conferirEntrada, contaAutorizada, lerEnvelope, traduzir } from './pagarme'

const HOJE = '2026-09-10T12:00:00.000Z'
const PROXIMA = '2026-10-10T12:00:00.000Z'

function envelope(type: string, data: unknown) {
  return lerEnvelope({ id: `hook_${type}`, type, created_at: HOJE, data })
}

describe('envelope', () => {
  it('recusa corpo sem id ou sem tipo', () => {
    expect(() => lerEnvelope({ type: 'charge.paid' })).toThrow()
    expect(() => lerEnvelope({ id: 'hook_1' })).toThrow()
    expect(() => lerEnvelope('nada disso')).toThrow()
  })

  it('sem data válida no topo, usa a chegada em vez de descartar o evento', () => {
    const e = lerEnvelope({ id: 'hook_1', type: 'charge.paid', created_at: 'ontem' })
    expect(Number.isNaN(new Date(e.occurredAt).getTime())).toBe(false)
  })
})

describe('tradução', () => {
  it('charge.paid de uma assinatura vira payment_succeeded com dono, plano e prazo', () => {
    const ev = traduzir(
      envelope('charge.paid', {
        id: 'ch_1',
        status: 'paid',
        customer: { id: 'cus_1', email: 'Marina@Exemplo.adv.br' },
        invoice: {
          id: 'in_1',
          subscription_id: 'sub_1',
          subscription: { next_billing_at: PROXIMA },
        },
        metadata: { plano: 'premium' },
      }),
    )
    expect(ev).toMatchObject({
      type: 'payment_succeeded',
      provider: 'pagarme',
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      // e-mail é chave de busca: casa em minúsculas ou não casa
      email: 'marina@exemplo.adv.br',
      plan: 'premium',
      currentPeriodEnd: PROXIMA,
    })
  })

  it('acha a assinatura em qualquer um dos lugares onde a Pagar.me a coloca', () => {
    const caminhos = [
      { subscription_id: 'sub_1' },
      { subscription: { id: 'sub_1' } },
      { invoice: { subscription_id: 'sub_1' } },
      { invoice: { subscription: { id: 'sub_1' } } },
      { object: 'subscription', id: 'sub_1' },
    ]
    for (const data of caminhos) {
      expect(traduzir(envelope('charge.paid', data))?.subscriptionId).toBe('sub_1')
    }
  })

  it('subscription.canceled vira subscription_canceled e leva o fim do período pago', () => {
    // Quem pagou o mês tem o mês: é esta data que impede o cancelamento de
    // derrubar o perfil no mesmo segundo.
    const ev = traduzir(
      envelope('subscription.canceled', {
        object: 'subscription',
        id: 'sub_1',
        customer: { id: 'cus_1' },
        current_period: { start_at: HOJE, end_at: PROXIMA },
      }),
    )
    expect(ev).toMatchObject({
      type: 'subscription_canceled',
      subscriptionId: 'sub_1',
      currentPeriodEnd: PROXIMA,
    })
  })

  it('falha de pagamento leva o motivo da adquirente para o registro', () => {
    const ev = traduzir(
      envelope('charge.payment_failed', {
        id: 'ch_1',
        customer: { id: 'cus_1' },
        last_transaction: { acquirer_message: 'Cartão vencido' },
      }),
    )
    expect(ev?.type).toBe('payment_failed')
    expect(ev?.reason).toBe('Cartão vencido')
  })

  it('invoice.paid e invoice.payment_failed também contam — a assinatura anuncia pelos dois', () => {
    expect(traduzir(envelope('invoice.paid', { id: 'in_1' }))?.type).toBe('payment_succeeded')
    expect(traduzir(envelope('invoice.payment_failed', { id: 'in_1' }))?.type).toBe('payment_failed')
  })

  it('NÃO inventa data quando o provedor foi omisso', () => {
    // Sem prazo, `valeAte()` devolve "sem prazo" e o acesso fica de pé. Uma data
    // chutada aqui viraria rebaixamento na varredura de daqui a seis horas.
    const ev = traduzir(envelope('charge.paid', { id: 'ch_1', customer: { id: 'cus_1' } }))
    expect(ev?.currentPeriodEnd).toBeUndefined()
  })

  it('ignora plano que não é nosso — renovação usa o que a pessoa já contratou', () => {
    const ev = traduzir(envelope('charge.paid', { id: 'ch_1', metadata: { plano: 'Profissional' } }))
    expect(ev?.plan).toBeUndefined()
  })

  it('evento que não mexe em assinatura devolve null em vez de virar coisa nenhuma', () => {
    for (const t of [
      'charge.created',
      'charge.pending',
      'charge.processing',
      'charge.refunded',
      'charge.antifraud_pending',
      'order.paid',
      'subscription_item.updated',
    ]) {
      expect(traduzir(envelope(t, { id: 'x' }))).toBeNull()
    }
  })

  it('o id do evento é o do provedor — é ele que faz a idempotência valer', () => {
    expect(traduzir(envelope('charge.paid', {}))?.id).toBe('hook_charge.paid')
  })
})

describe('trava de conta', () => {
  // Um backend só, duas contas na Pagar.me (teste e produção). Sem a trava, um
  // pagamento FALSO de teste com o e-mail de uma conta real dá plano de verdade.
  const PROD = 'acc_producao0000001'
  const TESTE = 'acc_teste000000001'
  const original = process.env.PAGARME_ACCOUNT_ID
  afterEach(() => {
    if (original === undefined) delete process.env.PAGARME_ACCOUNT_ID
    else process.env.PAGARME_ACCOUNT_ID = original
  })
  const de = (account: unknown) =>
    lerEnvelope({ id: 'hook_1', type: 'charge.paid', created_at: HOJE, account, data: {} })

  it('lê a conta do envelope', () => {
    expect(de({ id: PROD, name: 'Veacci' }).accountId).toBe(PROD)
    expect(de(undefined).accountId).toBeUndefined()
  })

  it('sem PAGARME_ACCOUNT_ID configurada, não aplica nada (fail closed)', () => {
    delete process.env.PAGARME_ACCOUNT_ID
    expect(contaAutorizada(de({ id: PROD }))).toEqual({
      ok: false,
      motivo: 'PAGARME_ACCOUNT_ID não configurada',
    })
  })

  it('evento do ambiente de TESTE não passa no servidor de produção', () => {
    process.env.PAGARME_ACCOUNT_ID = PROD
    expect(contaAutorizada(de({ id: PROD }))).toEqual({ ok: true })
    const r = contaAutorizada(de({ id: TESTE }))
    expect(r.ok).toBe(false)
    // o motivo leva a conta: é o que responde "por que meu evento não foi aplicado"
    expect(r.ok === false && r.motivo).toContain(TESTE)
  })

  it('evento sem conta não passa', () => {
    process.env.PAGARME_ACCOUNT_ID = PROD
    expect(contaAutorizada(de(undefined)).ok).toBe(false)
  })

  it('aceita lista separada por vírgula (servidor de testes que atende as duas)', () => {
    process.env.PAGARME_ACCOUNT_ID = ` ${PROD} , ${TESTE} `
    expect(contaAutorizada(de({ id: TESTE })).ok).toBe(true)
    expect(contaAutorizada(de({ id: 'acc_outra' })).ok).toBe(false)
  })
})

describe('fronteira', () => {
  const original = { ...process.env }
  afterEach(() => {
    process.env.PAGARME_WEBHOOK_TOKEN = original.PAGARME_WEBHOOK_TOKEN
    process.env.PAGARME_WEBHOOK_BASIC = original.PAGARME_WEBHOOK_BASIC
  })

  const basic = (s: string) => `Basic ${Buffer.from(s, 'utf8').toString('base64')}`

  it('sem nenhuma tranca configurada, recusa tudo (fail closed)', () => {
    delete process.env.PAGARME_WEBHOOK_TOKEN
    delete process.env.PAGARME_WEBHOOK_BASIC
    expect(() => conferirEntrada('qualquer-coisa', undefined)).toThrow(UnauthorizedException)
  })

  it('token no caminho: aceita o certo, recusa o errado e o ausente', () => {
    process.env.PAGARME_WEBHOOK_TOKEN = 'segredo-longo-de-teste-0123456789'
    delete process.env.PAGARME_WEBHOOK_BASIC
    expect(() => conferirEntrada('segredo-longo-de-teste-0123456789', undefined)).not.toThrow()
    expect(() => conferirEntrada('segredo-longo-de-teste-012345678', undefined)).toThrow()
    expect(() => conferirEntrada(undefined, undefined)).toThrow()
  })

  it('basic auth: aceita o certo, recusa o errado e o cabeçalho mal formado', () => {
    delete process.env.PAGARME_WEBHOOK_TOKEN
    process.env.PAGARME_WEBHOOK_BASIC = 'advocme:senha-longa-de-teste'
    expect(() => conferirEntrada(undefined, basic('advocme:senha-longa-de-teste'))).not.toThrow()
    expect(() => conferirEntrada(undefined, basic('advocme:errada'))).toThrow()
    expect(() => conferirEntrada(undefined, 'Bearer sei-la')).toThrow()
    expect(() => conferirEntrada(undefined, undefined)).toThrow()
  })

  it('as duas configuradas = as duas exigidas', () => {
    process.env.PAGARME_WEBHOOK_TOKEN = 'segredo-longo-de-teste-0123456789'
    process.env.PAGARME_WEBHOOK_BASIC = 'advocme:senha-longa-de-teste'
    expect(() =>
      conferirEntrada('segredo-longo-de-teste-0123456789', basic('advocme:senha-longa-de-teste')),
    ).not.toThrow()
    expect(() => conferirEntrada('segredo-longo-de-teste-0123456789', undefined)).toThrow()
    expect(() => conferirEntrada('errado', basic('advocme:senha-longa-de-teste'))).toThrow()
  })
})
