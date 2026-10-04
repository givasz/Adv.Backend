// A tradução do webhook do Asaas é onde erro de integração mora.
//
// Ela não decide política nenhuma — mas entrega os dados com que a política
// decide. Um pagamento de Pix que não libera nada, um cartão que só libera daqui a
// 30 dias, uma data de fim de período que cai em março para quem vence dia 31: as
// três falhas são silenciosas. Ninguém abre chamado dizendo "o evento foi
// traduzido errado"; a pessoa só descobre que pagou e não recebeu.

import { afterEach, describe, expect, it } from 'vitest'
import { UnauthorizedException } from '@nestjs/common'
import { conferirEntrada, lerEnvelope, marcaExterna, payloadSeguroParaAuditoria, traduzir } from './asaas'

const HOJE = '2026-09-29 14:00:00'

function envelope(event: string, recurso: Record<string, unknown>, chave = 'payment') {
  return lerEnvelope({ id: `evt_${event}`, event, dateCreated: HOJE, [chave]: recurso })
}

describe('envelope', () => {
  it('recusa corpo sem id ou sem tipo', () => {
    expect(() => lerEnvelope({ event: 'PAYMENT_CONFIRMED' })).toThrow()
    expect(() => lerEnvelope({ id: 'evt_1' })).toThrow()
    expect(() => lerEnvelope('nada disso')).toThrow()
  })

  it('sem data válida no topo, usa a chegada em vez de descartar o evento', () => {
    const e = lerEnvelope({ id: 'evt_1', event: 'PAYMENT_CONFIRMED', dateCreated: 'ontem' })
    expect(Number.isNaN(new Date(e.occurredAt).getTime())).toBe(false)
  })
})

describe('tradução', () => {
  const cobranca = {
    object: 'payment',
    id: 'pay_1',
    customer: 'cus_1',
    subscription: 'sub_1',
    billingType: 'CREDIT_CARD',
    dueDate: '2026-09-29',
    externalReference: marcaExterna('perfil_1', 'premium'),
  }

  it('cartão CONFIRMADO libera já — não espera os ~30 dias até o dinheiro cair', () => {
    expect(traduzir(envelope('PAYMENT_CONFIRMED', { ...cobranca, value: 49 }))).toMatchObject({
      type: 'payment_succeeded',
      provider: 'asaas',
      profileId: 'perfil_1',
      plan: 'premium',
      amount: 49,
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
    })
  })

  it('Pix pula o confirmado e vai direto a RECEBIDO — e isso também libera', () => {
    const pix = { ...cobranca, billingType: 'PIX' }
    expect(traduzir(envelope('PAYMENT_RECEIVED', pix))?.type).toBe('payment_succeeded')
  })

  it('VENCIDO vira falha de pagamento: abre a carência, não tira nada do ar', () => {
    expect(traduzir(envelope('PAYMENT_OVERDUE', cobranca))?.type).toBe('payment_failed')
  })

  it('captura recusada no cartão também vira falha de pagamento', () => {
    expect(traduzir(envelope('PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', cobranca))?.type).toBe('payment_failed')
  })

  it('reprovação pela análise de risco também vira falha de pagamento', () => {
    expect(traduzir(envelope('PAYMENT_REPROVED_BY_RISK_ANALYSIS', cobranca))?.type).toBe('payment_failed')
  })

  it('estorno integral e chargeback revertem o direito criado pelo pagamento', () => {
    for (const evento of ['PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED']) {
      expect(traduzir(envelope(evento, cobranca))?.type).toBe('payment_reversed')
    }
  })

  it('assinatura removida ou inativada vira cancelamento', () => {
    const sub = { object: 'subscription', id: 'sub_1', customer: 'cus_1', nextDueDate: '2026-10-29' }
    for (const ev of ['SUBSCRIPTION_DELETED', 'SUBSCRIPTION_INACTIVATED']) {
      const t = traduzir(envelope(ev, sub, 'subscription'))
      expect(t?.type).toBe('subscription_canceled')
      expect(t?.subscriptionId).toBe('sub_1')
    }
  })

  describe('fim do período pago', () => {
    it('é o vencimento deste ciclo mais um mês', () => {
      expect(traduzir(envelope('PAYMENT_CONFIRMED', cobranca))?.currentPeriodEnd).toBe(
        '2026-10-29T12:00:00.000Z',
      )
    })

    it('quem vence dia 31 vence no último dia do mês seguinte, não em março', () => {
      const t = traduzir(envelope('PAYMENT_CONFIRMED', { ...cobranca, dueDate: '2027-01-31' }))
      expect(t?.currentPeriodEnd).toBe('2027-02-28T12:00:00.000Z')
    })

    it('pagar atrasado não estica a assinatura: a conta usa o vencimento, não o pagamento', () => {
      const atrasado = { ...cobranca, dueDate: '2026-09-29', paymentDate: '2026-10-04' }
      expect(traduzir(envelope('PAYMENT_RECEIVED', atrasado))?.currentPeriodEnd).toBe(
        '2026-10-29T12:00:00.000Z',
      )
    })

    it('quando o provedor diz o próximo vencimento, a palavra dele vale mais que a nossa conta', () => {
      const t = traduzir(envelope('PAYMENT_CONFIRMED', { ...cobranca, nextDueDate: '2026-11-05' }))
      expect(t?.currentPeriodEnd).toBe('2026-11-05T12:00:00.000Z')
    })

    it('NÃO inventa data quando o provedor foi omisso', () => {
      // Sem prazo, `valeAte()` devolve "sem prazo" e o acesso fica de pé. Uma data
      // chutada aqui viraria rebaixamento na varredura de daqui a seis horas.
      const { dueDate: _, ...semData } = cobranca
      expect(traduzir(envelope('PAYMENT_CONFIRMED', semData))?.currentPeriodEnd).toBeUndefined()
    })
  })

  describe('referência externa', () => {
    it('só vale a que nós carimbamos', () => {
      const alheia = { ...cobranca, externalReference: 'pedido-123' }
      const t = traduzir(envelope('PAYMENT_CONFIRMED', alheia))
      expect(t?.profileId).toBeUndefined()
      expect(t?.plan).toBeUndefined()
    })

    it('plano que não é nosso é ignorado — a renovação usa o que a pessoa contratou', () => {
      const t = traduzir(
        envelope('PAYMENT_CONFIRMED', { ...cobranca, externalReference: 'advocme:perfil_1:ouro' }),
      )
      expect(t?.profileId).toBe('perfil_1')
      expect(t?.plan).toBeUndefined()
    })
  })

  it('evento que não mexe em assinatura devolve null em vez de virar coisa nenhuma', () => {
    for (const ev of [
      'PAYMENT_CREATED',
      'PAYMENT_UPDATED',
      'PAYMENT_DELETED',
      'PAYMENT_RESTORED',
      'PAYMENT_BANK_SLIP_VIEWED',
      'PAYMENT_CHECKOUT_VIEWED',
      'SUBSCRIPTION_CREATED',
      'SUBSCRIPTION_UPDATED',
    ]) {
      expect(traduzir(envelope(ev, cobranca))).toBeNull()
    }
  })

  it('o id do evento é o do provedor — é ele que faz a idempotência valer', () => {
    expect(traduzir(envelope('PAYMENT_CONFIRMED', cobranca))?.id).toBe('evt_PAYMENT_CONFIRMED')
  })
})

describe('fronteira', () => {
  const original = process.env.ASAAS_WEBHOOK_TOKEN
  afterEach(() => {
    if (original === undefined) delete process.env.ASAAS_WEBHOOK_TOKEN
    else process.env.ASAAS_WEBHOOK_TOKEN = original
  })

  const PROD = 'token-de-producao-com-32-caracteres-ou-mais'
  const SANDBOX = 'token-do-sandbox-com-32-caracteres-ou-mais-'

  it('sem token configurado, recusa tudo (fail closed)', () => {
    delete process.env.ASAAS_WEBHOOK_TOKEN
    expect(() => conferirEntrada(PROD)).toThrow(UnauthorizedException)
  })

  it('aceita o certo, recusa o errado e o ausente', () => {
    process.env.ASAAS_WEBHOOK_TOKEN = PROD
    expect(() => conferirEntrada(PROD)).not.toThrow()
    expect(() => conferirEntrada(PROD.slice(0, -1))).toThrow()
    expect(() => conferirEntrada(undefined)).toThrow()
  })

  it('o sandbox é outra conta com outro token: não passa no servidor de produção', () => {
    // É isto que impede um pagamento de mentira do sandbox de dar plano de
    // verdade a alguém.
    process.env.ASAAS_WEBHOOK_TOKEN = PROD
    expect(() => conferirEntrada(SANDBOX)).toThrow(UnauthorizedException)
  })

  it('uma máquina de desenvolvimento pode aceitar os dois', () => {
    process.env.ASAAS_WEBHOOK_TOKEN = ` ${PROD} , ${SANDBOX} `
    expect(() => conferirEntrada(SANDBOX)).not.toThrow()
    expect(() => conferirEntrada('outro-token-qualquer-com-32-caracteres')).toThrow()
  })
})

describe('payload de auditoria', () => {
  it('remove credenciais de cartao e dados do titular antes de persistir o webhook', () => {
    const payload = payloadSeguroParaAuditoria({
      id: 'evt_1',
      event: 'PAYMENT_CONFIRMED',
      payment: {
        id: 'pay_1',
        status: 'CONFIRMED',
        creditCard: {
          creditCardNumber: '8829',
          creditCardToken: 'token-reutilizavel',
          credit_card_token: 'token-em-snake-case',
          holderName: 'Nome do Titular',
        },
        cpfCnpj: '52998224725',
        email: 'titular@exemplo.com',
        address: 'Rua Particular',
      },
    })

    expect(payload).toContain('PAYMENT_CONFIRMED')
    expect(payload).not.toMatch(
      /token-reutilizavel|token-em-snake-case|Nome do Titular|52998224725|titular@exemplo\.com|8829|Rua Particular/,
    )
    expect(payload).toContain('[REMOVIDO]')
  })
})
