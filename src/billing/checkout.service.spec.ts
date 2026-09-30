// O checkout é o único lugar do sistema por onde passa número de cartão, e o
// único que decide QUANTO cobrar. Os erros que importam aqui não aparecem na tela:
// um cartão gravado num log, um preço vindo do navegador, uma cobrança em dobro
// depois de um tempo esgotado, um boleto entregue a quem pediu Pix.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { CheckoutService, limparPedido } from './checkout.service'
import { AsaasErro } from './asaas.api'

const AGORA = new Date('2026-09-29T15:00:00.000Z') // 12h em Brasília
const HOJE = '2026-09-29'

// Dados de exemplo. O CPF é gerado pelo algoritmo; o cartão é o de teste do Asaas.
const CPF = '529.982.247-25'
const NUMERO = '4444 4444 4444 4444'
const CVV = '987'
const CEP = '80420-210'
const TELEFONE = '(41) 99999-9999'

const PIX = { plano: 'pro', meio: 'PIX', cpfCnpj: CPF }
const BOLETO = { plano: 'pro', meio: 'BOLETO', cpfCnpj: CPF }
const CARTAO = {
  plano: 'premium',
  meio: 'CREDIT_CARD',
  cpfCnpj: CPF,
  cartao: { numero: NUMERO, nomeImpresso: 'MARINA SALES', mes: '12', ano: '30', cvv: CVV },
  titular: { cep: CEP, numeroEndereco: '1488', telefone: TELEFONE },
}

type Qualquer = Record<string, any>

function montar(o: { perfil?: Qualquer; asaas?: Qualquer; correioAtivo?: boolean } = {}) {
  const escritas: Qualquer[] = []
  const perfil = {
    id: 'p1',
    name: 'Marina Sales',
    plan: 'free',
    planStatus: 'active',
    currentPeriodEnd: null,
    graceUntil: null,
    planScheduled: null,
    billingCustomerId: null,
    billingSubscriptionId: null,
    user: { email: 'marina@exemplo.adv.br', emailVerifiedAt: new Date('2026-09-01') },
    ...o.perfil,
  }
  const prisma = {
    profile: {
      findUnique: vi.fn(async () => perfil),
      update: vi.fn(async (a: Qualquer) => (escritas.push(a.data), {})),
    },
  }
  const profiles = { aplicarAssinaturaPorPerfil: vi.fn(async () => ({})) }
  const asaas: Qualquer = {
    configurado: true,
    ambiente: 'sandbox',
    criarCliente: vi.fn(async () => ({ id: 'cus_1' })),
    atualizarCliente: vi.fn(async () => ({ id: 'cus_1' })),
    assinaturasDoCliente: vi.fn(async () => []),
    criarAssinatura: vi.fn(async (p: Qualquer) => ({
      id: 'sub_1',
      billingType: p.meio,
      status: 'ACTIVE',
      nextDueDate: '2026-10-29',
      externalReference: p.externalReference,
      creditCard: p.meio === 'CREDIT_CARD' ? { creditCardNumber: '4444', creditCardBrand: 'VISA' } : undefined,
    })),
    cobrancasDaAssinatura: vi.fn(async () => [
      {
        id: 'pay_1',
        billingType: 'PIX',
        status: 'PENDING',
        dueDate: HOJE,
        value: 29,
        invoiceUrl: 'https://sandbox.asaas.com/i/pay_1',
        bankSlipUrl: 'https://sandbox.asaas.com/b/pdf/pay_1',
      },
    ]),
    pixQrCode: vi.fn(async () => ({ encodedImage: 'iVBORw0K', payload: '00020126...', expirationDate: '2026-09-30' })),
    cancelarAssinatura: vi.fn(async () => {}),
    ...o.asaas,
  }
  const correio = { ativo: o.correioAtivo ?? false }
  const svc = new CheckoutService(prisma as any, profiles as any, asaas as any, correio as any)
  return { svc, prisma, profiles, asaas, escritas }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(AGORA)
})
afterEach(() => vi.useRealTimers())

describe('o pedido', () => {
  it('sem Asaas configurado, responde indisponível sem ler nada', async () => {
    const { svc, prisma } = montar({ asaas: { configurado: false } })
    await expect(svc.assinar('u1', PIX, '1.1.1.1')).rejects.toBeInstanceOf(ServiceUnavailableException)
    expect(prisma.profile.findUnique).not.toHaveBeenCalled()
  })

  it('CPF inválido é recusado antes de falar com o Asaas', async () => {
    const { svc, asaas } = montar()
    await expect(svc.assinar('u1', { ...PIX, cpfCnpj: '529.982.247-24' }, '1.1.1.1')).rejects.toBeInstanceOf(
      BadRequestException,
    )
    expect(asaas.criarCliente).not.toHaveBeenCalled()
  })

  it('em produção o número do cartão passa pelo Luhn; no sandbox, não (o cartão de teste falharia)', () => {
    expect(() => limparPedido(CARTAO, { agora: AGORA, exigirLuhn: true })).toThrow('número do cartão')
    expect(() => limparPedido(CARTAO, { agora: AGORA, exigirLuhn: false })).not.toThrow()
    const real = { ...CARTAO, cartao: { ...CARTAO.cartao, numero: '4111 1111 1111 1111' } }
    expect(() => limparPedido(real, { agora: AGORA, exigirLuhn: true })).not.toThrow()
  })

  it('cartão vencido é recusado', () => {
    const vencido = { ...CARTAO, cartao: { ...CARTAO.cartao, mes: '08', ano: '2026' } }
    expect(() => limparPedido(vencido, { agora: AGORA, exigirLuhn: false })).toThrow('validade')
    const ultimoMes = { ...CARTAO, cartao: { ...CARTAO.cartao, mes: '09', ano: '2026' } }
    expect(() => limparPedido(ultimoMes, { agora: AGORA, exigirLuhn: false })).not.toThrow()
  })

  it('nenhuma mensagem de erro repete o que foi digitado', () => {
    const errados = [
      { ...CARTAO, cartao: { ...CARTAO.cartao, cvv: '12' } },
      { ...CARTAO, cartao: { ...CARTAO.cartao, numero: '4111 1111 1111 1112' } },
      { ...CARTAO, titular: { ...CARTAO.titular, cep: '8042' } },
      { ...PIX, cpfCnpj: '529.982.247-24' },
    ]
    for (const pedido of errados) {
      let mensagem = ''
      try {
        limparPedido(pedido, { agora: AGORA, exigirLuhn: true })
      } catch (e) {
        mensagem = (e as Error).message
      }
      expect(mensagem, JSON.stringify(pedido)).not.toBe('') // tem de ter recusado
      expect(mensagem).not.toMatch(/\b12\b|4111|1112|8042|529/)
    }
  })
})

describe('o preço é do servidor', () => {
  it('o valor mandado pelo navegador é ignorado', async () => {
    const { svc, asaas } = montar()
    await svc.assinar('u1', { ...CARTAO, valor: 1, value: 1, price: 1 }, '1.1.1.1')
    expect(asaas.criarAssinatura.mock.calls[0][0].valor).toBe(49)
  })
})

describe('Pix e boleto', () => {
  it('Pix devolve o QR Code, grava só os identificadores e NÃO ativa o plano', async () => {
    const { svc, asaas, profiles, escritas } = montar()
    const r = await svc.assinar('u1', PIX, '1.1.1.1')
    expect(r).toMatchObject({ meio: 'PIX', situacao: 'aguardando', valor: 29, vencimento: HOJE })
    expect(r.meio === 'PIX' && r.pix?.copiaECola).toBe('00020126...')
    expect(asaas.criarAssinatura.mock.calls[0][0].externalReference).toBe('advocme:p1:pro')
    expect(escritas).toEqual([{ billingCustomerId: 'cus_1' }, { billingSubscriptionId: 'sub_1' }])
    // O plano abre quando o Asaas avisar que o dinheiro entrou — pelo webhook.
    expect(profiles.aplicarAssinaturaPorPerfil).not.toHaveBeenCalled()
  })

  it('Pix que o Asaas troca por boleto em silêncio: desfaz e avisa, não entrega boleto', async () => {
    const { svc, asaas, escritas } = montar({
      asaas: {
        criarAssinatura: vi.fn(async () => ({ id: 'sub_x', billingType: 'BOLETO', status: 'ACTIVE', nextDueDate: '2026-10-29' })),
      },
    })
    await expect(svc.assinar('u1', PIX, '1.1.1.1')).rejects.toThrow(/Pix/)
    expect(asaas.cancelarAssinatura).toHaveBeenCalledWith('sub_x')
    expect(escritas.some((e) => e.billingSubscriptionId === 'sub_x')).toBe(false)
  })

  it('boleto devolve o link do boleto e da fatura', async () => {
    const { svc } = montar()
    const r = await svc.assinar('u1', BOLETO, '1.1.1.1')
    expect(r).toMatchObject({ meio: 'BOLETO', situacao: 'aguardando', boleto: 'https://sandbox.asaas.com/b/pdf/pay_1' })
  })
})

describe('cartão', () => {
  const confirmada = vi.fn(async () => [
    { id: 'pay_1', billingType: 'CREDIT_CARD', status: 'CONFIRMED', dueDate: HOJE, value: 49 },
  ])

  it('aprovado ativa na hora, com a mesma data que o webhook gravaria', async () => {
    const { svc, profiles } = montar({ asaas: { cobrancasDaAssinatura: confirmada } })
    const r = await svc.assinar('u1', CARTAO, '1.1.1.1')
    expect(r).toMatchObject({ meio: 'CREDIT_CARD', situacao: 'ativo', cartao: { final: '4444', bandeira: 'VISA' } })
    const [profileId, patch] = profiles.aplicarAssinaturaPorPerfil.mock.calls[0] as any[]
    expect(profileId).toBe('p1')
    expect(patch).toMatchObject({ plan: 'premium', planStatus: 'active', planScheduled: null })
    // vencimento de hoje + 1 mês — exatamente o que asaas.ts calcula no webhook
    expect(patch.currentPeriodEnd.toISOString()).toBe('2026-10-29T12:00:00.000Z')
  })

  it('recusado: a mensagem do Asaas chega ao advogado e nenhuma assinatura é gravada', async () => {
    const { svc, escritas, profiles } = montar({
      asaas: {
        criarAssinatura: vi.fn(async () => {
          throw new AsaasErro(400, 'invalid_action', 'Transação não autorizada. Verifique os dados do cartão de crédito e tente novamente.')
        }),
      },
    })
    await expect(svc.assinar('u1', CARTAO, '1.1.1.1')).rejects.toThrow('Transação não autorizada')
    expect(escritas.some((e) => 'billingSubscriptionId' in e && e.billingSubscriptionId)).toBe(false)
    expect(profiles.aplicarAssinaturaPorPerfil).not.toHaveBeenCalled()
  })

  it('NADA que a pessoa digitou vai para o banco: cartão, CVV, CPF, CEP, telefone', async () => {
    const { svc, escritas, profiles } = montar({ asaas: { cobrancasDaAssinatura: confirmada } })
    await svc.assinar('u1', CARTAO, '1.1.1.1')
    const gravado = JSON.stringify([escritas, profiles.aplicarAssinaturaPorPerfil.mock.calls])
    for (const dado of ['4444444444444444', CVV, '52998224725', '80420210', '41999999999']) {
      expect(gravado).not.toContain(dado)
    }
  })

  it('o IP do cliente vai ao Asaas (antifraude exige)', async () => {
    const { svc, asaas } = montar({ asaas: { cobrancasDaAssinatura: confirmada } })
    await svc.assinar('u1', CARTAO, '200.1.2.3')
    expect(asaas.criarAssinatura.mock.calls[0][0].remoteIp).toBe('200.1.2.3')
  })
})

describe('quem pode assinar', () => {
  it('e-mail não confirmado, com o correio ligado: barra antes do Asaas', async () => {
    const { svc, asaas } = montar({ correioAtivo: true, perfil: { user: { email: 'x@y.z', emailVerifiedAt: null } } })
    await expect(svc.assinar('u1', PIX, '1.1.1.1')).rejects.toBeInstanceOf(ForbiddenException)
    expect(asaas.criarCliente).not.toHaveBeenCalled()
  })

  it('assinatura em dia: conflito, nada é criado — seria cobrar duas vezes', async () => {
    const { svc, asaas } = montar({
      perfil: { plan: 'pro', planStatus: 'active', billingSubscriptionId: 'sub_viva', currentPeriodEnd: new Date('2026-10-20') },
    })
    await expect(svc.assinar('u1', CARTAO, '1.1.1.1')).rejects.toBeInstanceOf(ConflictException)
    expect(asaas.criarAssinatura).not.toHaveBeenCalled()
  })

  it('quem cancelou e ainda tem dias pagos só começa a pagar quando eles acabam', async () => {
    const { svc, asaas } = montar({
      perfil: {
        plan: 'pro',
        planStatus: 'canceled',
        billingSubscriptionId: 'sub_cancelada',
        currentPeriodEnd: new Date('2026-10-15T12:00:00.000Z'),
      },
    })
    const r = await svc.assinar('u1', PIX, '1.1.1.1')
    expect(asaas.criarAssinatura.mock.calls[0][0].vencimento).toBe('2026-10-15')
    expect(asaas.cancelarAssinatura).toHaveBeenCalledWith('sub_cancelada')
    expect(r.situacao).toBe('aguardando') // a cobrança de teste do mock vence hoje
  })
})

describe('tentativas anteriores', () => {
  it('Pix abandonado é desfeito antes da nova tentativa', async () => {
    const { svc, asaas } = montar({ perfil: { billingSubscriptionId: 'sub_pix_velho' } })
    await svc.assinar('u1', BOLETO, '1.1.1.1')
    expect(asaas.cancelarAssinatura).toHaveBeenCalledWith('sub_pix_velho')
  })

  it('tempo esgotado na tentativa anterior: a assinatura que o Asaas criou é ADOTADA, não duplicada', async () => {
    const { svc, asaas } = montar({
      perfil: { billingCustomerId: 'cus_1' },
      asaas: {
        assinaturasDoCliente: vi.fn(async () => [
          { id: 'sub_orfa', billingType: 'CREDIT_CARD', status: 'ACTIVE', nextDueDate: '2026-10-29', externalReference: 'advocme:p1:premium' },
          { id: 'sub_outra', billingType: 'PIX', status: 'ACTIVE', nextDueDate: '2026-10-29', externalReference: 'advocme:p1:pro' },
          { id: 'sub_alheia', billingType: 'PIX', status: 'ACTIVE', nextDueDate: '2026-10-29', externalReference: 'pedido-123' },
        ]),
        cobrancasDaAssinatura: vi.fn(async () => [
          { id: 'pay_1', billingType: 'CREDIT_CARD', status: 'CONFIRMED', dueDate: HOJE, value: 49 },
        ]),
      },
    })
    const r = await svc.assinar('u1', CARTAO, '1.1.1.1')
    expect(asaas.criarAssinatura).not.toHaveBeenCalled()
    expect(r.situacao).toBe('ativo')
    // a outra NOSSA sai; a que não é nossa não é tocada
    expect(asaas.cancelarAssinatura).toHaveBeenCalledWith('sub_outra')
    expect(asaas.cancelarAssinatura).not.toHaveBeenCalledWith('sub_alheia')
  })

  it('tempo esgotado agora: a mensagem não promete que nada foi cobrado', async () => {
    const { svc } = montar({
      asaas: {
        criarAssinatura: vi.fn(async () => {
          throw new AsaasErro(0, 'tempo_esgotado', 'O provedor de pagamento não respondeu.')
        }),
      },
    })
    const erro = await svc.assinar('u1', CARTAO, '1.1.1.1').catch((e) => e)
    expect(erro).toBeInstanceOf(ServiceUnavailableException)
    expect(erro.message).toContain('não é cobrado duas vezes')
    expect(erro.message).not.toMatch(/nada foi cobrado/i)
  })
})

describe('cancelar', () => {
  it('plano pago: apaga no Asaas e aplica o cancelamento — quem pagou o mês tem o mês', async () => {
    const fim = new Date('2026-10-20T12:00:00.000Z')
    const { svc, asaas, profiles } = montar({
      perfil: { plan: 'premium', billingSubscriptionId: 'sub_1', currentPeriodEnd: fim },
    })
    const r = await svc.cancelar('u1')
    expect(asaas.cancelarAssinatura).toHaveBeenCalledWith('sub_1')
    const patch = (profiles.aplicarAssinaturaPorPerfil.mock.calls[0] as any[])[1]
    expect(patch).toMatchObject({ planStatus: 'canceled' })
    expect(r.valeAte).toBe(fim.toISOString())
  })

  it('plano nunca pago (Pix em aberto): só some o vínculo, o status não muda', async () => {
    const { svc, profiles, escritas } = montar({ perfil: { billingSubscriptionId: 'sub_pix' } })
    await svc.cancelar('u1')
    expect(profiles.aplicarAssinaturaPorPerfil).not.toHaveBeenCalled()
    expect(escritas).toEqual([{ billingSubscriptionId: null }])
  })

  it('falha no Asaas: diz que nada mudou, e nada muda', async () => {
    const { svc, profiles } = montar({
      perfil: { plan: 'pro', billingSubscriptionId: 'sub_1' },
      asaas: { cancelarAssinatura: vi.fn(async () => { throw new AsaasErro(500, 'erro', '') }) },
    })
    await expect(svc.cancelar('u1')).rejects.toThrow('Nada mudou')
    expect(profiles.aplicarAssinaturaPorPerfil).not.toHaveBeenCalled()
  })
})
