// Checkout, Minha assinatura e o Programa Advocme Parceiros.
//
//   • cartão aprovado na hora → o programa recebe o id da COBRANÇA (o mesmo que o
//     webhook trará depois, e por isso não há segunda recompensa);
//   • Pix e boleto aguardando, cartão em análise → nada;
//   • o Max de cortesia não é assinatura: quem tem só ele assina normalmente;
//   • cancelar com devolução revoga; cancelar sem devolução, não.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CheckoutService } from './checkout.service'
import { MinhaAssinaturaService } from './minha-assinatura.service'

const AGORA = new Date('2026-10-07T15:00:00.000Z')
const HOJE = '2026-10-07'
const CPF = '529.982.247-25'
const PIX = { plano: 'pro', meio: 'PIX', cpfCnpj: CPF }
const BOLETO = { plano: 'pro', meio: 'BOLETO', cpfCnpj: CPF }
const CARTAO = {
  plano: 'premium',
  meio: 'CREDIT_CARD',
  cpfCnpj: CPF,
  cartao: { numero: '4444 4444 4444 4444', nomeImpresso: 'MARINA SALES', mes: '12', ano: '30', cvv: '987' },
  titular: { cep: '80420-210', numeroEndereco: '1488', telefone: '(41) 99999-9999' },
}

function checkout(o: { status?: string; perfil?: Record<string, any> } = {}) {
  const perfil = {
    id: 'p1',
    name: 'Marina',
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
  const prisma: any = { profile: { findUnique: vi.fn(async () => perfil), update: vi.fn(async () => ({})) } }
  const profiles: any = { aplicarAssinaturaPorPerfil: vi.fn(async () => ({})) }
  const asaas: any = {
    configurado: true,
    ambiente: 'sandbox',
    criarCliente: vi.fn(async () => ({ id: 'cus_1' })),
    atualizarCliente: vi.fn(async () => ({ id: 'cus_1' })),
    assinaturasDoCliente: vi.fn(async () => []),
    criarAssinatura: vi.fn(async (p: any) => ({
      id: 'sub_1',
      billingType: p.meio,
      status: 'ACTIVE',
      nextDueDate: HOJE,
      externalReference: p.externalReference,
    })),
    cobrancasDaAssinatura: vi.fn(async () => [{ id: 'pay_77', billingType: 'X', status: o.status ?? 'PENDING', dueDate: HOJE, value: 49 }]),
    pixQrCode: vi.fn(async () => ({ encodedImage: 'x', payload: 'y' })),
    cancelarAssinatura: vi.fn(async () => {}),
    notificacoesSoPorEmail: vi.fn(async () => {}),
  }
  const partners: any = { registrarConversao: vi.fn(async () => 'criada') }
  const svc = new CheckoutService(prisma, profiles, asaas, { ativo: false } as any, partners)
  return { svc, partners, profiles }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(AGORA)
})
afterEach(() => vi.useRealTimers())

describe('checkout', () => {
  it('cartão confirmado na hora → o programa recebe o id da cobrança e o valor cobrado', async () => {
    const { svc, partners } = checkout({ status: 'CONFIRMED' })
    expect(await svc.assinar('u1', CARTAO, '1.1.1.1')).toMatchObject({ situacao: 'ativo' })
    expect(partners.registrarConversao).toHaveBeenCalledWith({ profileId: 'p1', plan: 'premium', amount: 49, paymentId: 'pay_77' })
  })

  it('cartão em análise, Pix e boleto aguardando: nada chega ao programa', async () => {
    for (const [pedido, status] of [
      [CARTAO, 'PENDING'],
      [PIX, 'PENDING'],
      [BOLETO, 'PENDING'],
    ] as const) {
      const { svc, partners } = checkout({ status })
      await svc.assinar('u1', pedido, '1.1.1.1')
      expect(partners.registrarConversao).not.toHaveBeenCalled()
    }
  })

  it('o Max de cortesia não conta como assinatura: quem só tem ele assina normalmente', async () => {
    const { svc } = checkout({
      status: 'CONFIRMED',
      perfil: { billingSubscriptionId: 'sub_velha', partner: { status: 'active', benefitUntil: new Date('2026-12-01') } },
    })
    await expect(svc.assinar('u1', CARTAO, '1.1.1.1')).resolves.toMatchObject({ situacao: 'ativo' })
  })

  it('um erro do programa não derruba um checkout aprovado', async () => {
    const { svc, partners, profiles } = checkout({ status: 'CONFIRMED' })
    partners.registrarConversao.mockRejectedValueOnce(new Error('fora'))
    await expect(svc.assinar('u1', CARTAO, '1.1.1.1')).resolves.toMatchObject({ situacao: 'ativo' })
    expect(profiles.aplicarAssinaturaPorPerfil).toHaveBeenCalledTimes(1)
  })
})

function minha(o: { pagas?: any[]; estornoFalha?: boolean } = {}) {
  const perfil = {
    id: 'p1',
    name: 'Marina',
    plan: 'pro',
    planStatus: 'active',
    currentPeriodEnd: new Date('2026-11-01T12:00:00Z'),
    graceUntil: null,
    planScheduled: null,
    billingCustomerId: 'cus_1',
    billingSubscriptionId: 'sub_1',
    user: { email: 'marina@exemplo.adv.br' },
  }
  const prisma: any = {
    profile: { findUnique: vi.fn(async () => perfil), update: vi.fn(async () => ({})) },
    supportTicket: { create: vi.fn(async () => ({})) },
  }
  const profiles: any = { aplicarAssinaturaPorPerfil: vi.fn(async () => ({})) }
  const asaas: any = {
    configurado: true,
    cobrancasDaAssinatura: vi.fn(async () => o.pagas ?? []),
    cancelarAssinatura: vi.fn(async () => {}),
    estornar: vi.fn(async () => (o.estornoFalha ? Promise.reject(new Error('saldo')) : {})),
  }
  const partners: any = { revogarPorPagamento: vi.fn(async () => 'revogada') }
  return { svc: new MinhaAssinaturaService(prisma, profiles, asaas, partners), partners }
}

describe('Minha assinatura', () => {
  it('cancelar dentro do arrependimento devolve o valor e revoga a recompensa daquele pagamento', async () => {
    const paga = { id: 'pay_1', status: 'CONFIRMED', value: 29, dueDate: '2026-10-05', confirmedDate: '2026-10-05' }
    const { svc, partners } = minha({ pagas: [paga] })
    expect(await svc.cancelar('u1', AGORA)).toMatchObject({ devolucao: 'feita' })
    expect(partners.revogarPorPagamento).toHaveBeenCalledWith('pay_1', expect.stringMatching(/devolvido/))
  })

  it('cancelar sem devolução (fora do prazo): o pagamento continua válido, nada é revogado', async () => {
    const paga = { id: 'pay_1', status: 'CONFIRMED', value: 29, dueDate: '2026-09-01', confirmedDate: '2026-09-01' }
    const outra = { ...paga, id: 'pay_2', dueDate: '2026-10-01', confirmedDate: '2026-10-01' }
    const { svc, partners } = minha({ pagas: [paga, outra] })
    expect(await svc.cancelar('u1', AGORA)).toMatchObject({ devolucao: null })
    expect(partners.revogarPorPagamento).not.toHaveBeenCalled()
  })

  it('devolução que falhou (vira chamado): nada é revogado antes de o dinheiro voltar', async () => {
    const paga = { id: 'pay_1', status: 'CONFIRMED', value: 29, dueDate: '2026-10-05', confirmedDate: '2026-10-05' }
    const { svc, partners } = minha({ pagas: [paga], estornoFalha: true })
    expect(await svc.cancelar('u1', AGORA)).toMatchObject({ devolucao: 'pendente' })
    expect(partners.revogarPorPagamento).not.toHaveBeenCalled()
  })
})
