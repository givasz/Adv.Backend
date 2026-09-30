// O CHECKOUT CONTRA O SANDBOX DE VERDADE — rodado à mão, nunca na suíte comum.
//
// Os testes de checkout.service.spec.ts usam um Asaas de mentira, e por isso não
// pegam o erro mais provável desta integração: um pedido no formato errado (um
// campo com nome trocado, um filtro que a API não aceita). Este aqui usa a
// AsaasApi real, falando com o sandbox, e confere o caminho inteiro.
//
// Como rodar (a chave vem de ~/.advocme-secrets, sem aparecer no terminal):
//
//   ASAAS_TESTE_REAL=1 ASAAS_AMBIENTE=sandbox ASAAS_API_KEY="$(cat …)" \
//     npx vitest run src/billing/asaas.sandbox.spec.ts
//
// Recusa-se a rodar com ASAAS_AMBIENTE diferente de `sandbox`: um teste que cria
// assinatura e cobra cartão não pode, por descuido de variável, rodar na produção.
// Tudo o que ele cria é apagado no fim.

import { afterAll, describe, expect, it, vi } from 'vitest'
import { AsaasApi } from './asaas.api'
import { CheckoutService } from './checkout.service'
import { MinhaAssinaturaService } from './minha-assinatura.service'

const REAL =
  process.env.ASAAS_TESTE_REAL === '1' &&
  process.env.ASAAS_AMBIENTE === 'sandbox' &&
  !!process.env.ASAAS_API_KEY

function cpfDeTeste(): string {
  let n: number[]
  do n = [...Array(9)].map(() => Math.floor(Math.random() * 10))
  while (new Set(n).size === 1)
  const dv = (a: number[]) => {
    const r = (a.reduce((t, v, i) => t + v * (a.length + 1 - i), 0) * 10) % 11
    return r === 10 ? 0 : r
  }
  n.push(dv(n))
  n.push(dv(n))
  return n.join('')
}

describe.skipIf(!REAL)('checkout contra o sandbox do Asaas', () => {
  const api = new AsaasApi()
  const cpf = cpfDeTeste()
  const perfil: Record<string, any> = {
    id: `sandbox-${Date.now()}`,
    name: 'Teste Sandbox Advocme',
    plan: 'free',
    planStatus: 'active',
    currentPeriodEnd: null,
    graceUntil: null,
    planScheduled: null,
    billingCustomerId: null,
    billingSubscriptionId: null,
    user: { email: 'sandbox-teste@example.com', emailVerifiedAt: new Date() },
  }
  // Banco de mentira que GUARDA o que é gravado — o fluxo depende disso entre chamadas.
  const chamados: any[] = []
  const prisma = {
    profile: {
      findUnique: async () => perfil,
      update: async (a: any) => Object.assign(perfil, a.data),
    },
    supportTicket: { create: async (a: any) => (chamados.push(a.data), {}) },
  }
  const profiles = {
    aplicarAssinaturaPorPerfil: async (_: string, patch: any) => Object.assign(perfil, patch),
  }
  const svc = new CheckoutService(prisma as any, profiles as any, api, { ativo: false } as any)
  const minha = new MinhaAssinaturaService(prisma as any, profiles as any, api)

  const cartao = (numero: string) => ({
    plano: 'premium',
    meio: 'CREDIT_CARD',
    cpfCnpj: cpf,
    cartao: { numero, nomeImpresso: 'TESTE SANDBOX', mes: '12', ano: '2030', cvv: '123' },
    titular: { cep: '80420210', numeroEndereco: '1488', telefone: '41999999999' },
  })

  afterAll(async () => {
    if (!perfil.billingCustomerId) return
    for (const s of await api.assinaturasDoCliente(perfil.billingCustomerId)) await api.cancelarAssinatura(s.id)
    await fetch(`https://api-sandbox.asaas.com/v3/customers/${perfil.billingCustomerId}`, {
      method: 'DELETE',
      headers: { access_token: process.env.ASAAS_API_KEY!, 'User-Agent': 'advoc.me' },
    })
  }, 60_000)

  it('Pix: cria cliente e assinatura e devolve o QR Code, sem ativar o plano', async () => {
    const r = await svc.assinar('u', { plano: 'pro', meio: 'PIX', cpfCnpj: cpf }, '200.200.200.200')
    expect(r.meio).toBe('PIX')
    expect(r.situacao).toBe('aguardando')
    expect(r.meio === 'PIX' && r.pix?.copiaECola).toMatch(/^000201/)
    expect(perfil.billingCustomerId).toMatch(/^cus_/)
    expect(perfil.billingSubscriptionId).toMatch(/^sub_/)
    expect(perfil.plan).toBe('free')
  }, 60_000)

  it('cartão recusado: a mensagem do Asaas chega, e a assinatura Pix anterior foi desfeita', async () => {
    await expect(svc.assinar('u', cartao('5184019740373151'), '200.200.200.200')).rejects.toThrow(
      /não autorizada/i,
    )
    const vivas = await api.assinaturasDoCliente(perfil.billingCustomerId)
    expect(vivas).toHaveLength(0)
  }, 60_000)

  it('cartão de teste aprovado: ativa o Max na hora', async () => {
    const r = await svc.assinar('u', cartao('4444444444444444'), '200.200.200.200')
    expect(r).toMatchObject({ meio: 'CREDIT_CARD', situacao: 'ativo', cartao: { final: '4444' } })
    expect(perfil.plan).toBe('premium')
    expect(perfil.planStatus).toBe('active')
    expect(perfil.currentPeriodEnd).toBeInstanceOf(Date)
  }, 60_000)

  it('tempo esgotado simulado: a nova tentativa ADOTA a assinatura, não cobra de novo', async () => {
    // Como se a chamada anterior tivesse estourado os 12 s antes de gravarmos o
    // vínculo: o Asaas tem a assinatura, o nosso banco não sabe dela.
    Object.assign(perfil, { billingSubscriptionId: null, plan: 'free', currentPeriodEnd: null })
    const criar = vi.spyOn(api, 'criarAssinatura')
    const r = await svc.assinar('u', cartao('4444444444444444'), '200.200.200.200')
    expect(criar).not.toHaveBeenCalled()
    expect(r.situacao).toBe('ativo')
    expect(await api.assinaturasDoCliente(perfil.billingCustomerId)).toHaveLength(1)
  }, 60_000)

  it('minha assinatura: cartão, valor, próxima cobrança e o prazo de arrependimento aberto', async () => {
    const r = await minha.resumo('u')
    expect(r.assinatura).toMatchObject({ meio: 'CREDIT_CARD', valor: 49, cartao: { final: '4444' }, emAberto: null })
    expect(r.assinatura?.proximaCobranca).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(r.assinatura?.arrependimentoAte).not.toBeNull()
  }, 60_000)

  it('trocar o cartão: o Asaas passa a cobrar no novo', async () => {
    const r = await minha.trocarCartao(
      'u',
      { cpfCnpj: cpf, cartao: { numero: '4111111111111111', nomeImpresso: 'TESTE SANDBOX', mes: '11', ano: '2031', cvv: '321' }, titular: { cep: '80420210', numeroEndereco: '1488', telefone: '41999999999' } },
      '200.200.200.200',
    )
    expect(r.assinatura?.cartao?.final).toBe('1111')
  }, 60_000)

  it('descer para o Pro fica agendado, e o Asaas passa a cobrar R$ 29 na próxima', async () => {
    const r = (await minha.trocarPlano('u', { plano: 'pro' }, '200.200.200.200')) as any
    expect(perfil.plan).toBe('premium') // o mês pago de Max continua
    expect(perfil.planScheduled).toBe('pro')
    expect(r.assinatura.valor).toBe(29)
  }, 60_000)

  it('desfazer a descida: volta a R$ 49 e some o agendamento', async () => {
    const r = (await minha.trocarPlano('u', { plano: 'premium' }, '200.200.200.200')) as any
    expect(perfil.planScheduled).toBeNull()
    expect(r.assinatura.valor).toBe(49)
  }, 60_000)

  it('cancelar dentro dos 7 dias DEVOLVE o valor e termina o plano agora', async () => {
    const antes = Date.now()
    const r = await minha.cancelar('u')
    expect(r).toMatchObject({ devolucao: 'feita', valeAte: null, valorDevolvido: 49 })
    expect(chamados).toHaveLength(0)
    expect(perfil.planStatus).toBe('canceled')
    expect(new Date(perfil.currentPeriodEnd).getTime()).toBeGreaterThanOrEqual(antes - 1000)
    expect(new Date(perfil.currentPeriodEnd).getTime()).toBeLessThanOrEqual(Date.now() + 1000)
    expect(await api.assinaturasDoCliente(perfil.billingCustomerId)).toHaveLength(0)
  }, 60_000)
})
