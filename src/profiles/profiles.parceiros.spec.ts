// O perfil e o Programa Advocme Parceiros.
//
//   • a leitura entrega o Max de cortesia enquanto ele vale, e fecha no segundo
//     em que vence — sem esperar varredura;
//   • `subscription` continua falando SÓ de cobrança: um Pro parceiro não aparece
//     como "rebaixado" nem "em cortesia";
//   • o benefício vai ao dono e nunca ao visitante;
//   • a reconciliação acerta tema, agenda e endereço, sem apagar conteúdo, e não
//     reabre o prazo do endereço numa segunda passada.

import { describe, expect, it, vi } from 'vitest'
import { ProfilesService } from './profiles.service'

type Qualquer = Record<string, any>
const DIA = 24 * 60 * 60 * 1000
const daqui = (n: number) => new Date(Date.now() + n * DIA)

function servico(extra: Qualquer = {}) {
  const linha: Qualquer = {
    id: 'p1',
    userId: 'u1',
    name: 'Marina Sales',
    slug: 'marina-sales',
    oabNumber: 'OAB/SP 123',
    moderationStatus: 'active',
    moderationUntil: null,
    hiddenSections: '[]',
    plan: 'free',
    planStatus: 'active',
    currentPeriodEnd: null,
    graceUntil: null,
    planScheduled: null,
    slugGraceUntil: null,
    theme: 'papel',
    schedulingMode: 'off',
    videoUrl: 'https://www.youtube.com/watch?v=abc',
    videoCaption: '',
    card: '',
    brandName: 'Sales Advocacia',
    areas: [],
    faqs: [],
    socials: [],
    published: true,
    policyRevChecked: 0,
    partner: null,
    ...extra,
  }
  const gravado: Qualquer[] = []
  const prisma: Qualquer = {
    profile: {
      findUnique: vi.fn(async (a: Qualquer) => {
        if (a?.where?.slug !== undefined) return a.where.slug === linha.slug ? { userId: 'u1' } : null
        return { ...linha }
      }),
      findFirst: vi.fn(async () => ({ ...linha })),
      update: vi.fn(async (a: Qualquer) => {
        gravado.push(a.data)
        Object.assign(linha, a.data)
        return { ...linha }
      }),
    },
    auditLog: { create: vi.fn(async () => ({})) },
    linkEvent: { create: vi.fn(() => ({ catch: () => undefined })) },
  }
  return { svc: new ProfilesService(prisma as any), gravado, linha, prisma }
}

const beneficio = (ate: Date, status = 'active') => ({ partner: { status, benefitUntil: ate } })

describe('leitura do plano efetivo', () => {
  it('FREE com benefício ativo lê Max; os recursos do Max aparecem', async () => {
    const { svc } = servico(beneficio(daqui(10)))
    const p = await svc.getMine('u1')
    expect(p.plan).toBe('premium')
    expect(p.videoUrl).toBeTruthy()
    expect(p.branding).toMatchObject({ brandName: 'Sales Advocacia' })
  })

  it('benefício vencido: volta ao Free na hora, só pela leitura (nada gravado)', async () => {
    const { svc, gravado } = servico(beneficio(new Date(Date.now() - 1000)))
    const p = await svc.getMine('u1')
    expect(p.plan).toBe('free')
    expect(p.videoUrl).toBeUndefined()
    expect(gravado).toEqual([])
  })

  it('subscription segue financeira: Pro parceiro não está "rebaixado" nem "em cortesia"', async () => {
    const { svc } = servico({ plan: 'pro', currentPeriodEnd: daqui(20), ...beneficio(daqui(10)) })
    const p = await svc.getMine('u1')
    expect(p.plan).toBe('premium')
    expect(p.subscription).toMatchObject({ plan: 'pro', rebaixado: false, cortesia: false })
    expect(p.partnerBenefit).toMatchObject({ status: 'active', active: true })
  })

  it('o benefício vai ao dono; o visitante não vê nada do programa', async () => {
    const { svc } = servico(beneficio(daqui(10)))
    const publico = await svc.getBySlug('marina-sales', false)
    expect(publico.plan).toBe('premium')
    expect(publico).not.toHaveProperty('partnerBenefit')
    expect(publico).not.toHaveProperty('partner')
    expect(publico).not.toHaveProperty('subscription')
    expect(JSON.stringify(publico)).not.toMatch(/benefitUntil|referral|parceir/i)
  })

  it('perfil sem participação: resposta igual à de sempre, sem campo novo', async () => {
    const { svc } = servico()
    const p = await svc.getMine('u1')
    expect(p.plan).toBe('free')
    expect(p).not.toHaveProperty('partnerBenefit')
  })
})

describe('reconciliação do plano efetivo', () => {
  it('benefício ativado no Free: entrega o endereço limpo; não toca em conteúdo', async () => {
    const { svc, gravado } = servico({ slug: 'marina-sales-4821', ...beneficio(daqui(45)) })
    const r = await svc.reconciliarPlanoEfetivo('p1', 'free', 'parceiros: ativado')
    expect(r).toMatchObject({ antes: 'free', depois: 'premium', mudou: true })
    expect(gravado).toEqual([{ slug: 'marina-sales' }])
  })

  it('benefício vencido no Free: tema e agenda voltam ao Free, abre UMA semana de prazo do endereço', async () => {
    const { svc, gravado, linha } = servico({ theme: 'nevoa', schedulingMode: 'assistant', ...beneficio(daqui(-1)) })
    await svc.reconciliarPlanoEfetivo('p1', 'premium', 'parceiros: fim')
    expect(Object.keys(gravado[0]!).sort()).toEqual(['schedulingMode', 'slugGraceUntil', 'theme'])
    expect(gravado[0]).toMatchObject({ theme: 'papel', schedulingMode: 'off' })
    const prazo = linha.slugGraceUntil.getTime()
    expect(prazo).toBeGreaterThan(Date.now() + 6 * DIA)
    // Segunda passada: nada a fazer — o prazo NÃO é reiniciado.
    expect(await svc.reconciliarPlanoEfetivo('p1', 'premium', 'parceiros: fim')).toMatchObject({ mudou: false })
    expect(linha.slugGraceUntil.getTime()).toBe(prazo)
  })

  it('nunca grava fora do que o público veria errado: vídeo, marca e cartão ficam', async () => {
    const { svc, gravado } = servico({ theme: 'nevoa', schedulingMode: 'assistant', ...beneficio(daqui(-1)) })
    await svc.reconciliarPlanoEfetivo('p1', 'premium', 'parceiros: fim')
    for (const g of gravado) {
      for (const k of Object.keys(g)) expect(['theme', 'schedulingMode', 'slug', 'slugGraceUntil']).toContain(k)
    }
  })

  it('PRO parceiro ao fim do benefício: continua Pro, sem prazo de endereço', async () => {
    const { svc, linha } = servico({ plan: 'pro', currentPeriodEnd: daqui(20), schedulingMode: 'assistant', ...beneficio(daqui(-1)) })
    expect(await svc.reconciliarPlanoEfetivo('p1', 'premium', 'parceiros: fim')).toMatchObject({ depois: 'pro' })
    expect(linha.slugGraceUntil).toBeNull()
    expect(linha.schedulingMode).toBe('assistant')
  })

  it('endereço já numerado não ganha prazo nenhum', async () => {
    const { svc, linha } = servico({ slug: 'marina-sales-4821', ...beneficio(daqui(-1)) })
    await svc.reconciliarPlanoEfetivo('p1', 'premium', 'parceiros: fim')
    expect(linha.slugGraceUntil).toBeNull()
  })
})

describe('a cobrança não enxerga o benefício', () => {
  it('quem tem só o Max de cortesia ainda pode subir para um plano pago pelo setPlan (sem Asaas)', async () => {
    const { svc, gravado } = servico(beneficio(daqui(10)))
    const p = await svc.setPlan('u1', 'pro')
    expect(gravado.some((g) => g.plan === 'pro')).toBe(true)
    // E o efetivo segue Max enquanto o benefício valer.
    expect(p.plan).toBe('premium')
  })
})
