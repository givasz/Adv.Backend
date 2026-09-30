// A vida da assinatura depois de assinar. O que não pode falhar aqui é dinheiro:
// devolver quando se prometeu devolver, nunca cobrar depois de cancelar, nunca
// cobrar duas vezes o mesmo mês numa troca de plano.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common'
import { MinhaAssinaturaService, prazoDeArrependimento } from './minha-assinatura.service'
import { AsaasErro, type CobrancaAsaas } from './asaas.api'

const AGORA = new Date('2026-09-30T15:00:00.000Z')
type Qualquer = Record<string, any>

const paga = (o: Partial<CobrancaAsaas> = {}): CobrancaAsaas => ({
  id: 'pay_1',
  billingType: 'CREDIT_CARD',
  status: 'CONFIRMED',
  dueDate: '2026-09-28',
  value: 49,
  confirmedDate: '2026-09-28',
  ...o,
})

function montar(o: { perfil?: Qualquer; asaas?: Qualquer } = {}) {
  const escritas: Qualquer[] = []
  const chamados: Qualquer[] = []
  const perfil = {
    id: 'p1',
    name: 'Marina Sales',
    plan: 'premium',
    planStatus: 'active',
    currentPeriodEnd: new Date('2026-10-28T12:00:00.000Z'),
    graceUntil: null,
    planScheduled: null,
    billingCustomerId: 'cus_1',
    billingSubscriptionId: 'sub_1',
    user: { email: 'marina@exemplo.adv.br' },
    ...o.perfil,
  }
  const prisma = {
    profile: {
      findUnique: vi.fn(async () => perfil),
      update: vi.fn(async (a: Qualquer) => (escritas.push(a.data), {})),
    },
    supportTicket: { create: vi.fn(async (a: Qualquer) => (chamados.push(a.data), {})) },
  }
  const profiles = { aplicarAssinaturaPorPerfil: vi.fn(async () => ({})) }
  const ordem: string[] = []
  const asaas: Qualquer = {
    configurado: true,
    ambiente: 'sandbox',
    obterAssinatura: vi.fn(async () => ({
      id: 'sub_1',
      billingType: 'CREDIT_CARD',
      status: 'ACTIVE',
      nextDueDate: '2026-10-28',
      value: 49,
      creditCard: { creditCardNumber: '4444', creditCardBrand: 'VISA', creditCardToken: 'segredo' },
    })),
    cobrancasDaAssinatura: vi.fn(async () => [paga()]),
    pixQrCode: vi.fn(async () => ({ encodedImage: 'iVBOR', payload: '000201' })),
    cancelarAssinatura: vi.fn(async () => void ordem.push('cancelar')),
    estornar: vi.fn(async () => (ordem.push('estornar'), { id: 'pay_1', status: 'REFUNDED' })),
    atualizarAssinatura: vi.fn(async () => ({})),
    criarAssinatura: vi.fn(async () => ({ id: 'sub_nova', billingType: 'CREDIT_CARD', status: 'ACTIVE', nextDueDate: '2026-10-28' })),
    trocarCartao: vi.fn(async () => ({})),
    ...o.asaas,
  }
  const svc = new MinhaAssinaturaService(prisma as any, profiles as any, asaas as any)
  return { svc, prisma, profiles, asaas, escritas, chamados, ordem }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(AGORA)
})
afterEach(() => vi.useRealTimers())

describe('prazo de arrependimento', () => {
  it('7 dias a partir da confirmação do PRIMEIRO pagamento', () => {
    expect(prazoDeArrependimento([paga({ confirmedDate: '2026-09-28' })], AGORA)).not.toBeNull()
    expect(prazoDeArrependimento([paga({ confirmedDate: '2026-09-23' })], AGORA)).not.toBeNull() // 7º dia
    expect(prazoDeArrependimento([paga({ confirmedDate: '2026-09-22' })], AGORA)).toBeNull()
  })

  it('quem já renovou não está se arrependendo de contratar, está cancelando', () => {
    expect(prazoDeArrependimento([paga(), paga({ id: 'pay_2' })], AGORA)).toBeNull()
  })

  it('sem pagamento, sem prazo', () => {
    expect(prazoDeArrependimento([], AGORA)).toBeNull()
  })
})

describe('resumo', () => {
  it('mostra meio, valor, cartão e o prazo — e nunca o token do cartão', async () => {
    const { svc } = montar()
    const r = await svc.resumo('u1')
    expect(r.assinatura).toMatchObject({ meio: 'CREDIT_CARD', valor: 49, proximaCobranca: '2026-10-28' })
    expect(r.assinatura?.cartao).toEqual({ final: '4444', bandeira: 'VISA' })
    expect(r.assinatura?.arrependimentoAte).not.toBeNull()
    expect(JSON.stringify(r)).not.toContain('segredo')
  })

  it('Pix em aberto vem com o QR Code', async () => {
    const { svc } = montar({
      asaas: {
        obterAssinatura: vi.fn(async () => ({ id: 'sub_1', billingType: 'PIX', status: 'ACTIVE', nextDueDate: '2026-10-28', value: 29 })),
        cobrancasDaAssinatura: vi.fn(async () => [paga({ billingType: 'PIX', status: 'PENDING', dueDate: '2026-10-28' })]),
      },
    })
    const r = await svc.resumo('u1')
    expect(r.assinatura?.emAberto).toMatchObject({ vencimento: '2026-10-28', vencida: false, pix: { copiaECola: '000201' } })
  })

  it('Asaas fora do ar: a tela não some — mostra o que o banco sabe', async () => {
    const { svc } = montar({ asaas: { obterAssinatura: vi.fn(async () => { throw new AsaasErro(0, 'rede', '') }) } })
    const r = await svc.resumo('u1')
    expect(r).toMatchObject({ plano: 'premium', status: 'active', assinatura: null })
  })
})

describe('cancelar', () => {
  it('no prazo: APAGA primeiro, devolve depois, e o plano termina agora', async () => {
    const { svc, profiles, ordem } = montar()
    const r = await svc.cancelar('u1')
    // Se a devolução viesse antes e o cancelamento falhasse, o advogado teria o
    // dinheiro de volta e a próxima cobrança marcada.
    expect(ordem).toEqual(['cancelar', 'estornar'])
    expect(r).toMatchObject({ devolucao: 'feita', valeAte: null, valorDevolvido: 49 })
    const patch = (profiles.aplicarAssinaturaPorPerfil.mock.calls[0] as any[])[1]
    expect(patch).toMatchObject({ planStatus: 'canceled' })
    expect(patch.currentPeriodEnd).toEqual(AGORA)
  })

  it('fora do prazo: não devolve, e quem pagou o mês tem o mês', async () => {
    const { svc, asaas, profiles } = montar({
      asaas: { cobrancasDaAssinatura: vi.fn(async () => [paga({ confirmedDate: '2026-09-01' })]) },
    })
    const r = await svc.cancelar('u1')
    expect(asaas.estornar).not.toHaveBeenCalled()
    expect(r.devolucao).toBeNull()
    expect(r.valeAte).toBe('2026-10-28T12:00:00.000Z')
    const patch = (profiles.aplicarAssinaturaPorPerfil.mock.calls[0] as any[])[1]
    expect(patch.currentPeriodEnd).toEqual(new Date('2026-10-28T12:00:00.000Z'))
  })

  it('devolução automática falhou: cancela mesmo assim e abre chamado com o valor', async () => {
    const { svc, chamados, profiles } = montar({
      asaas: { estornar: vi.fn(async () => { throw new AsaasErro(400, 'insufficient_balance', 'Saldo insuficiente') }) },
    })
    const r = await svc.cancelar('u1')
    expect(r.devolucao).toBe('pendente')
    expect(chamados).toHaveLength(1)
    expect(chamados[0]).toMatchObject({ userId: 'u1', kind: 'conta', pageUrl: '/assinatura' })
    expect(chamados[0].message).toContain('R$ 49,00')
    // sem devolução feita, o mês pago continua valendo
    const patch = (profiles.aplicarAssinaturaPorPerfil.mock.calls[0] as any[])[1]
    expect(patch.currentPeriodEnd).toEqual(new Date('2026-10-28T12:00:00.000Z'))
  })

  it('Asaas não cancelou: nada muda, nada é devolvido', async () => {
    const { svc, asaas, profiles } = montar({
      asaas: { cancelarAssinatura: vi.fn(async () => { throw new AsaasErro(500, 'erro', '') }) },
    })
    await expect(svc.cancelar('u1')).rejects.toThrow('Nada mudou')
    expect(asaas.estornar).not.toHaveBeenCalled()
    expect(profiles.aplicarAssinaturaPorPerfil).not.toHaveBeenCalled()
  })

  it('plano nunca pago (Pix em aberto): só desfaz o vínculo', async () => {
    const { svc, escritas, profiles, asaas } = montar({
      perfil: { plan: 'free', currentPeriodEnd: null },
      asaas: { cobrancasDaAssinatura: vi.fn(async () => [paga({ status: 'PENDING' })]) },
    })
    await svc.cancelar('u1')
    expect(asaas.estornar).not.toHaveBeenCalled()
    expect(profiles.aplicarAssinaturaPorPerfil).not.toHaveBeenCalled()
    expect(escritas).toEqual([{ billingSubscriptionId: null }])
  })
})

describe('trocar de plano', () => {
  it('subir vale na hora; o Asaas passa a cobrar o valor novo na próxima', async () => {
    const { svc, asaas, profiles } = montar({ perfil: { plan: 'pro' } })
    await svc.trocarPlano('u1', { plano: 'premium' }, '1.1.1.1')
    expect(asaas.atualizarAssinatura).toHaveBeenCalledWith('sub_1', {
      valor: 49,
      externalReference: 'advocme:p1:premium',
      descricao: 'advoc.me Max (mensal)',
    })
    const patch = (profiles.aplicarAssinaturaPorPerfil.mock.calls[0] as any[])[1]
    expect(patch).toMatchObject({ plan: 'premium' })
  })

  it('descer fica agendado para o fim do mês pago', async () => {
    const { svc, profiles } = montar()
    await svc.trocarPlano('u1', { plano: 'pro' }, '1.1.1.1')
    const patch = (profiles.aplicarAssinaturaPorPerfil.mock.calls[0] as any[])[1]
    expect(patch).toEqual({ planScheduled: 'pro' })
  })

  it('Free é cancelar', async () => {
    const { svc, asaas } = montar()
    const r = await svc.trocarPlano('u1', { plano: 'free' }, '1.1.1.1')
    expect(asaas.cancelarAssinatura).toHaveBeenCalledWith('sub_1')
    expect(r).toHaveProperty('devolucao')
  })

  it('cartão sem tokenização em produção: pede o cartão de novo, e não muda nada ainda', async () => {
    const { svc, asaas, profiles } = montar({
      perfil: { plan: 'pro' },
      asaas: { atualizarAssinatura: vi.fn(async () => { throw new AsaasErro(400, 'invalid_action', 'Tokenização não habilitada') }) },
    })
    const erro = await svc.trocarPlano('u1', { plano: 'premium' }, '1.1.1.1').catch((e) => e)
    expect(erro).toBeInstanceOf(ConflictException)
    expect(erro.getResponse()).toMatchObject({ codigo: 'precisa_cartao' })
    expect(asaas.criarAssinatura).not.toHaveBeenCalled()
    expect(profiles.aplicarAssinaturaPorPerfil).not.toHaveBeenCalled()
  })

  it('com o cartão: assinatura nova cobrando no dia em que a antiga cobraria — nunca duas vezes o mesmo mês', async () => {
    const { svc, asaas, escritas } = montar({
      perfil: { plan: 'pro' },
      asaas: { atualizarAssinatura: vi.fn(async () => { throw new AsaasErro(400, 'invalid_action', 'Tokenização não habilitada') }) },
    })
    await svc.trocarPlano(
      'u1',
      {
        plano: 'premium',
        cpfCnpj: '529.982.247-25',
        cartao: { numero: '4444 4444 4444 4444', nomeImpresso: 'MARINA SALES', mes: '12', ano: '30', cvv: '987' },
        titular: { cep: '80420-210', numeroEndereco: '1488', telefone: '41999999999' },
      },
      '200.1.2.3',
    )
    const pedido = asaas.criarAssinatura.mock.calls[0][0]
    expect(pedido).toMatchObject({ vencimento: '2026-10-28', valor: 49, externalReference: 'advocme:p1:premium' })
    expect(asaas.cancelarAssinatura).toHaveBeenCalledWith('sub_1')
    expect(escritas).toContainEqual({ billingSubscriptionId: 'sub_nova' })
    // e nada do cartão foi para o banco
    expect(JSON.stringify(escritas)).not.toMatch(/4444444444444444|987|52998224725/)
  })

  it('sem assinatura ativa: conflito, para a tela mandar ao checkout', async () => {
    const { svc } = montar({ perfil: { planStatus: 'canceled' } })
    await expect(svc.trocarPlano('u1', { plano: 'pro' }, '1.1.1.1')).rejects.toBeInstanceOf(ConflictException)
  })
})

describe('trocar o cartão', () => {
  it('assinatura que não é no cartão: recusa', async () => {
    const { svc } = montar({
      asaas: { obterAssinatura: vi.fn(async () => ({ id: 'sub_1', billingType: 'PIX', status: 'ACTIVE', nextDueDate: '2026-10-28' })) },
    })
    await expect(
      svc.trocarCartao('u1', { cpfCnpj: '529.982.247-25' }, '1.1.1.1'),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it('recusa do Asaas chega com a mensagem dele; o cartão anterior segue valendo', async () => {
    const { svc } = montar({
      asaas: {
        trocarCartao: vi.fn(async () => {
          throw new AsaasErro(400, 'invalid_action', 'Transação não autorizada. Verifique os dados do cartão de crédito e tente novamente.')
        }),
      },
    })
    await expect(
      svc.trocarCartao(
        'u1',
        {
          cpfCnpj: '529.982.247-25',
          cartao: { numero: '5184 0197 4037 3151', nomeImpresso: 'MARINA SALES', mes: '12', ano: '30', cvv: '987' },
          titular: { cep: '80420-210', numeroEndereco: '1488', telefone: '41999999999' },
        },
        '1.1.1.1',
      ),
    ).rejects.toThrow('Transação não autorizada')
  })

  it('pagamento on-line desligado: indisponível', async () => {
    const { svc } = montar({ asaas: { configurado: false } })
    await expect(svc.trocarCartao('u1', {}, '1.1.1.1')).rejects.toBeInstanceOf(ServiceUnavailableException)
  })
})
