// Cadastro com o link de um parceiro (Programa Advocme Parceiros).
//
// O que não pode regredir:
//   • conta nova por senha ou pelo Google nasce ligada ao parceiro do link;
//   • entrar numa conta que já existia NUNCA cria indicação;
//   • link inválido, vencido ou de parceiro suspenso não atrapalha o cadastro;
//   • sem link, o cadastro é exatamente o de sempre;
//   • o cookie sai depois de consumido.

import { describe, expect, it, vi } from 'vitest'
import { AuthService } from './auth.service'
import { TERMS_VERSION } from '../legal/termos'
import { REF_COOKIE, REF_MARCA_COOKIE, selarAtribuicao, VALIDADE_DA_ATRIBUICAO_MS } from '../partners/partner-attribution'

const PARCEIRO = 'memb00000001'
const SENHA = 'Marina#Sales2026'
const ACEITE = { aceitou: true, ip: '203.0.113.9' }

function requisicao(cookies: Record<string, string> = {}) {
  const apagados: string[] = []
  return {
    apagados,
    auth: {
      cookie: (n: string) => cookies[n],
      method: 'POST',
      setCookie: () => undefined,
      clearCookie: (n: string) => apagados.push(n),
    },
  }
}

function montar(opcoes: { status?: string; contas?: Record<string, any>[]; falharComIndicacao?: boolean } = {}) {
  const users = opcoes.contas ?? []
  const criados: any[] = []
  const prisma: any = {
    user: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.googleSub) return users.find((u) => u.googleSub === where.googleSub) ?? null
        if (where.id) return users.find((u) => u.id === where.id) ?? null
        return users.find((u) => u.email === where.email) ?? null
      }),
      update: vi.fn(async ({ where, data }: any) => Object.assign(users.find((u) => u.id === where.id)!, data)),
      create: vi.fn(async ({ data }: any) => {
        if (opcoes.falharComIndicacao && data.receivedPartnerReferral) throw Object.assign(new Error('fk'), { code: 'P2003' })
        criados.push(data)
        const { profile, receivedPartnerReferral, ...resto } = data
        const nova = { id: `u${users.length + 1}`, ...resto, profile: { id: 'p-nova', ...profile.create } }
        users.push(nova)
        return nova
      }),
    },
    partnerMembership: {
      findUnique: vi.fn(async () =>
        opcoes.status ? { id: PARCEIRO, status: opcoes.status, profile: { userId: 'u-parceiro' } } : null,
      ),
    },
    firmInvite: { findFirst: vi.fn(async () => null) },
  }
  const sessions: any = {
    abrir: vi.fn(async () => ({ expiresAt: 1, csrfToken: 'c', remember: true })),
    encerrarTodas: vi.fn(async () => 1),
  }
  const correio: any = { ativo: false, enfileirar: vi.fn(async () => true) }
  return { svc: new AuthService(prisma, sessions, correio), prisma, criados }
}

const comLink = (selo = selarAtribuicao(PARCEIRO)) => requisicao({ [REF_COOKIE]: selo })

describe('cadastro por senha', () => {
  it('sem link: exatamente o cadastro de sempre, sem consultar o programa', async () => {
    const { svc, prisma, criados } = montar({ status: 'active' })
    const req = requisicao()
    await svc.signup(req as any, 'nova@exemplo.com', SENHA, 'Nova', true, ACEITE)
    expect(criados[0].receivedPartnerReferral).toBeUndefined()
    expect(prisma.partnerMembership.findUnique).not.toHaveBeenCalled()
    expect(req.apagados).toEqual([])
  })

  it('com link de parceiro ativo: a conta nasce ligada a ele, na mesma escrita, e o cookie sai', async () => {
    const { svc, criados } = montar({ status: 'active' })
    const req = comLink()
    const s = await svc.signup(req as any, 'nova@exemplo.com', SENHA, 'Nova', true, ACEITE)
    expect(criados[0].receivedPartnerReferral).toEqual({ create: { partnerId: PARCEIRO } })
    expect(criados[0].termsVersion).toBe(TERMS_VERSION)
    expect(s.user.plan).toBe('free')
    expect(req.apagados.sort()).toEqual([REF_COOKIE, REF_MARCA_COOKIE].sort())
  })

  it('link de parceiro suspenso ou encerrado: cadastro normal, sem indicação', async () => {
    for (const status of ['suspended', 'ended', 'invited']) {
      const { svc, criados } = montar({ status })
      await svc.signup(comLink() as any, 'nova@exemplo.com', SENHA, 'Nova', true, ACEITE)
      expect(criados[0].receivedPartnerReferral, status).toBeUndefined()
    }
  })

  it('link vencido, adulterado ou de parceiro inexistente: cadastro normal', async () => {
    const vencido = selarAtribuicao(PARCEIRO, Date.now() - VALIDADE_DA_ATRIBUICAO_MS - 1000)
    for (const selo of [vencido, 'lixo.assinatura', `${selarAtribuicao(PARCEIRO).slice(0, -3)}xyz`]) {
      const { svc, criados } = montar({ status: 'active' })
      await svc.signup(comLink(selo) as any, 'nova@exemplo.com', SENHA, 'Nova', true, ACEITE)
      expect(criados[0].receivedPartnerReferral).toBeUndefined()
    }
    const { svc, criados } = montar({ status: undefined })
    await svc.signup(comLink() as any, 'nova@exemplo.com', SENHA, 'Nova', true, ACEITE)
    expect(criados[0].receivedPartnerReferral).toBeUndefined()
  })

  it('se o vínculo falhar na escrita, a conta nasce mesmo assim — sem indicação', async () => {
    const { svc, criados } = montar({ status: 'active', falharComIndicacao: true })
    const s = await svc.signup(comLink() as any, 'nova@exemplo.com', SENHA, 'Nova', true, ACEITE)
    expect(s.user.email).toBe('nova@exemplo.com')
    expect(criados).toHaveLength(1)
    expect(criados[0].receivedPartnerReferral).toBeUndefined()
  })

  it('e-mail que já tem conta: recusa como sempre, e nenhuma indicação é criada', async () => {
    const { svc, prisma } = montar({ status: 'active', contas: [{ id: 'u1', email: 'ja@exemplo.com' }] })
    await expect(svc.signup(comLink() as any, 'ja@exemplo.com', SENHA, 'Ja', true, ACEITE)).rejects.toMatchObject({ status: 409 })
    expect(prisma.user.create).not.toHaveBeenCalled()
  })
})

describe('Continuar com o Google', () => {
  const IDENTIDADE = { sub: 'g-777', email: 'google@exemplo.com', nome: 'Nova Google' }

  it('conta NOVA: nasce ligada ao parceiro do link', async () => {
    const { svc, criados } = montar({ status: 'active' })
    const req = comLink()
    const r = await svc.entrarComGoogle(req as any, IDENTIDADE, { lembrar: true, aceitouTermos: true, ip: '1.1.1.1' })
    expect(r).toMatchObject({ etapa: 'sessao', novaConta: true })
    expect(criados[0].receivedPartnerReferral).toEqual({ create: { partnerId: PARCEIRO } })
    expect(req.apagados).toContain(REF_COOKIE)
  })

  it('conta que JÁ EXISTE (pelo sub ou pelo e-mail): entra, e nunca vira indicação', async () => {
    const existente = {
      id: 'u1',
      email: 'google@exemplo.com',
      password: '',
      googleSub: 'g-777',
      emailVerifiedAt: new Date(),
      suspendedUntil: null,
      suspendedReason: '',
      closedAt: null,
      closedReason: '',
      termsVersion: TERMS_VERSION,
      profile: { name: 'Antiga', plan: 'free', planStatus: 'active', currentPeriodEnd: null, graceUntil: null, partner: null },
    }
    const { svc, prisma } = montar({ status: 'active', contas: [existente] })
    const r = await svc.entrarComGoogle(comLink() as any, IDENTIDADE, { lembrar: true, aceitouTermos: true, ip: '1.1.1.1' })
    expect(r).toMatchObject({ etapa: 'sessao', novaConta: false })
    expect(prisma.user.create).not.toHaveBeenCalled()
    expect(prisma.partnerMembership.findUnique).not.toHaveBeenCalled()

    const porEmail = { ...existente, id: 'u2', googleSub: null, email: 'outro@exemplo.com' }
    const m2 = montar({ status: 'active', contas: [porEmail] })
    await m2.svc.entrarComGoogle(comLink() as any, { ...IDENTIDADE, email: 'outro@exemplo.com' }, { lembrar: true, aceitouTermos: true, ip: '1.1.1.1' })
    expect(m2.prisma.user.create).not.toHaveBeenCalled()
  })

  it('a sessão da conta existente devolve o plano EFETIVO, com o Max de parceiro', async () => {
    const existente = {
      id: 'u1',
      email: 'google@exemplo.com',
      password: '',
      googleSub: 'g-777',
      emailVerifiedAt: new Date(),
      suspendedUntil: null,
      suspendedReason: '',
      closedAt: null,
      closedReason: '',
      termsVersion: TERMS_VERSION,
      profile: {
        name: 'Parceira',
        plan: 'free',
        planStatus: 'active',
        currentPeriodEnd: null,
        graceUntil: null,
        partner: { status: 'active', benefitUntil: new Date(Date.now() + 86_400_000) },
      },
    }
    const { svc } = montar({ contas: [existente] })
    const r = await svc.entrarComGoogle(requisicao() as any, IDENTIDADE, { lembrar: true, aceitouTermos: true, ip: '1.1.1.1' })
    expect(r.etapa === 'sessao' && r.sessao.user.plan).toBe('premium')
  })
})

describe('convite do programa feito antes de a conta existir', () => {
  it('o cadastro com o mesmo e-mail cria a participação CONVIDADA; sem convite, nada muda', async () => {
    const { svc, prisma } = montar()
    const membros: any[] = []
    prisma.partnerInvite = {
      findUnique: vi.fn(async ({ where }: any) =>
        where.email === 'convidada@exemplo.com' ? { id: 'conv1', createdAt: new Date() } : null,
      ),
      delete: vi.fn(async () => ({})),
    }
    prisma.partnerMembership.create = vi.fn(async ({ data }: any) => (membros.push(data), { id: 'memb-nova' }))
    await svc.signup(requisicao() as any, 'convidada@exemplo.com', SENHA, 'Convidada', true, ACEITE)
    expect(membros).toEqual([expect.objectContaining({ profileId: 'p-nova', status: 'invited' })])
    expect(prisma.partnerInvite.delete).toHaveBeenCalledWith({ where: { id: 'conv1' } })

    await svc.signup(requisicao() as any, 'outra@exemplo.com', SENHA, 'Outra', true, ACEITE)
    expect(membros).toHaveLength(1)
  })
})
