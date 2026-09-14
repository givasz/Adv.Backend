// ASSINAR PEDE O E-MAIL CONFIRMADO — PUBLICAR, NÃO.
//
// Publicar um perfil Free não gera cobrança nem prazo de pagamento, e travar a
// publicação na confirmação poria o botão de publicar na dependência da cota
// diária do provedor de e-mail e da pasta de spam (decisão de 14/09/2026; o
// pedido fica em linha na revisão e na conclusão — frontend auth/EmailDaConta).
//
// Assinar é outra coisa: é por e-mail que chegam a falha do cartão, o fim da
// carência e o aviso de que o endereço limpo vai ser renumerado. O que estes
// testes travam:
//
//   • SUBIR de plano com e-mail pendente é recusado, e nada é gravado;
//   • DESCER e CANCELAR nunca travam — ninguém fica preso a um plano pago;
//   • com o correio desligado não há exigência: o link pedido nunca chegaria.
//
// Prisma é dublê — o que se verifica é o que o serviço RECUSOU e o que mandou gravar.

import { ForbiddenException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { ProfilesService } from './profiles.service'

type Qualquer = Record<string, any>

function service(o: { plan?: 'free' | 'pro' | 'premium'; confirmado?: boolean; correioAtivo?: boolean } = {}) {
  const linha: Qualquer = {
    id: 'p1',
    userId: 'u1',
    moderationStatus: 'active',
    plan: o.plan ?? 'free',
    planStatus: 'active',
    currentPeriodEnd: null,
    graceUntil: null,
    planScheduled: null,
    slugGraceUntil: null,
    oabNumber: 'OAB/SP 123',
    name: 'Marina Sales',
    slug: 'marina-sales-4827',
    headline: '',
    bio: '',
    theme: 'papel',
    schedulingMode: 'off',
    videoUrl: null,
    videoCaption: '',
    card: '',
    brandName: null,
    brandAccent: null,
    brandHideWatermark: false,
    customDomain: null,
    areas: [],
    faqs: [],
    socials: [],
    published: true,
    policyRevChecked: 0,
    user: { emailVerifiedAt: o.confirmado ? new Date() : null },
  }

  const gravado: Qualquer[] = []
  const prisma: Qualquer = {
    profile: {
      findUnique: vi.fn((a: Qualquer) => {
        // resolveSlug pergunta por SLUG; o resto pergunta por userId/id.
        if (a?.where?.slug !== undefined) {
          return Promise.resolve(a.where.slug === linha.slug ? { userId: 'u1' } : null)
        }
        return Promise.resolve({ ...linha })
      }),
      findFirst: vi.fn(() => Promise.resolve({ ...linha })),
      update: vi.fn((a: Qualquer) => {
        gravado.push(a.data)
        return Promise.resolve({ ...linha, ...a.data })
      }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    linkEvent: { create: vi.fn(() => ({ catch: () => undefined })) },
  }
  const correio = o.correioAtivo === undefined ? undefined : ({ ativo: o.correioAtivo } as any)
  return { svc: new ProfilesService(prisma as any, correio), gravado }
}

describe('assinar pede o e-mail confirmado', () => {
  it('subir do Free com o e-mail pendente é recusado, e nada é gravado', async () => {
    const { svc, gravado } = service({ confirmado: false, correioAtivo: true })
    await expect(svc.setPlan('u1', 'pro')).rejects.toThrow(ForbiddenException)
    await expect(svc.setPlan('u1', 'premium')).rejects.toThrow(/Confirme seu e-mail/)
    expect(gravado).toHaveLength(0)
  })

  it('com o e-mail confirmado, assina', async () => {
    const { svc, gravado } = service({ confirmado: true, correioAtivo: true })
    await svc.setPlan('u1', 'pro')
    expect(gravado[0]!.plan).toBe('pro')
  })

  it('subir de Pro para Max também pede — é cobrança nova', async () => {
    const { svc, gravado } = service({ plan: 'pro', confirmado: false, correioAtivo: true })
    await expect(svc.setPlan('u1', 'premium')).rejects.toThrow(ForbiddenException)
    expect(gravado).toHaveLength(0)
  })

  it('descer e cancelar nunca travam: ninguém fica preso a um plano pago por causa de um e-mail', async () => {
    const { svc, gravado } = service({ plan: 'premium', confirmado: false, correioAtivo: true })
    await svc.setPlan('u1', 'pro')
    await svc.setPlan('u1', 'free')
    expect(gravado).toHaveLength(2)
  })

  it('correio desligado não trava a compra: o link pedido nunca chegaria', async () => {
    const { svc, gravado } = service({ confirmado: false, correioAtivo: false })
    await svc.setPlan('u1', 'pro')
    expect(gravado[0]!.plan).toBe('pro')
  })
})
