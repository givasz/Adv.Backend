// COM O PAGAMENTO ON-LINE LIGADO, `setPlan` NÃO COBRA NADA — E POR ISSO NÃO ABRE NADA.
//
// Esta rota nasceu quando assinar era clicar um botão. Com o Asaas configurado,
// ela vira atalho nos dois sentidos, e os dois custam dinheiro:
//
//   • SUBIR por aqui seria o Max de graça para quem chamasse a rota direto;
//   • DESCER por aqui mudaria o plano no nosso banco e deixaria a cobrança
//     correndo no Asaas — a pessoa sairia do Max e continuaria pagando por ele.
//
// Sem o Asaas configurado, a rota segue como sempre foi (os outros testes de
// setPlan rodam sem as variáveis e provam isso).

import { ConflictException, ForbiddenException } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProfilesService } from './profiles.service'
import { asaasConfigurado } from '../billing/asaas.api'

function service(linha: Record<string, unknown>) {
  const update = vi.fn()
  const prisma = {
    profile: {
      findUnique: vi.fn(async () => ({
        id: 'p1',
        plan: 'free',
        planStatus: 'active',
        currentPeriodEnd: null,
        graceUntil: null,
        planScheduled: null,
        billingSubscriptionId: null,
        user: { emailVerifiedAt: new Date() },
        ...linha,
      })),
      update,
    },
  }
  return { svc: new ProfilesService(prisma as any), update }
}

describe('setPlan com o Asaas ligado', () => {
  const antes = {
    chave: process.env.ASAAS_API_KEY,
    ambiente: process.env.ASAAS_AMBIENTE,
    webhook: process.env.ASAAS_WEBHOOK_TOKEN,
  }
  beforeEach(() => {
    process.env.ASAAS_API_KEY = '$aact_teste'
    process.env.ASAAS_AMBIENTE = 'producao'
    process.env.ASAAS_WEBHOOK_TOKEN = 'token-de-webhook-com-32-caracteres-ou-mais'
  })
  afterEach(() => {
    if (antes.chave === undefined) delete process.env.ASAAS_API_KEY
    else process.env.ASAAS_API_KEY = antes.chave
    if (antes.ambiente === undefined) delete process.env.ASAAS_AMBIENTE
    else process.env.ASAAS_AMBIENTE = antes.ambiente
    if (antes.webhook === undefined) delete process.env.ASAAS_WEBHOOK_TOKEN
    else process.env.ASAAS_WEBHOOK_TOKEN = antes.webhook
  })

  it('subir é recusado: plano pago só abre com pagamento', async () => {
    const { svc, update } = service({ plan: 'free' })
    await expect(svc.setPlan('u1', 'premium')).rejects.toThrow(ForbiddenException)
    await expect(svc.setPlan('u1', 'pro')).rejects.toThrow(/ativado pelo pagamento/)
    expect(update).not.toHaveBeenCalled()
  })

  it('descer ou cancelar uma assinatura do Asaas por aqui é recusado — a cobrança seguiria correndo', async () => {
    const { svc, update } = service({ plan: 'premium', billingSubscriptionId: 'sub_1' })
    await expect(svc.setPlan('u1', 'pro')).rejects.toThrow(ConflictException)
    await expect(svc.setPlan('u1', 'free')).rejects.toThrow(/Minha assinatura/)
    expect(update).not.toHaveBeenCalled()
  })

  it('só conta como ligado com chave, webhook forte e ambiente válido', () => {
    expect(asaasConfigurado()).toBe(true)
    delete process.env.ASAAS_WEBHOOK_TOKEN
    expect(asaasConfigurado()).toBe(false)
    process.env.ASAAS_WEBHOOK_TOKEN = 'token-de-webhook-com-32-caracteres-ou-mais'
    process.env.ASAAS_AMBIENTE = 'prod'
    expect(asaasConfigurado()).toBe(false)
    process.env.ASAAS_AMBIENTE = 'sandbox'
    process.env.ASAAS_API_KEY = '   '
    expect(asaasConfigurado()).toBe(false)
  })
})
