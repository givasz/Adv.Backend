// PROGRAMA ADVOCME PARCEIROS — as regras de negócio.
//
// O que estes testes travam, em uma frase cada:
//
//   • o aceite dá 45 dias uma vez só, sem tocar no plano contratado;
//   • quem paga MAX com renovação ativa não ativa a cortesia;
//   • recompensa só nasce de pagamento confirmado, uma por indicação, e o mesmo
//     pagamento não vale duas vezes — venha pelo webhook, pelo checkout ou pelos dois;
//   • a validação de 7 dias é respeitada, e duas confirmações simultâneas somam as duas;
//   • estorno revoga uma vez só e nunca deixa o prazo antes de agora;
//   • suspensão e encerramento param o benefício sem apagar histórico;
//   • o parceiro nunca vê dado de quem indicou.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bancoFalso } from '../../test/parceiros/banco-falso'
import { descontar, normalizarOab, PartnersService, prorrogar, rotuloDaIndicacao } from './partners.service'
import { abrirAtribuicao, REF_COOKIE, REF_MARCA_COOKIE, selarAtribuicao } from './partner-attribution'
import { planoVigente, somarDias } from '../assinatura'
import { AVISO_OBRIGATORIO, AVISO_PRO, PARTNER_TERMS_VERSION } from './partner-terms'

const AGORA = new Date('2026-10-07T12:00:00.000Z')
const dias = (n: number, base = AGORA) => somarDias(base, n)

function montar(o: { asaasFalha?: boolean } = {}) {
  const banco = bancoFalso()
  const reconciliar = vi.fn(async () => ({ mudou: false }))
  // A porta financeira de verdade grava no perfil; aqui, o mesmo efeito na linha do banco falso.
  const aplicarAssinaturaPorPerfil = vi.fn(async (id: string, patch: Record<string, unknown>) => {
    Object.assign(banco.t.profile.find((p) => p.id === id)!, patch)
  })
  const profiles: any = { reconciliarPlanoEfetivo: reconciliar, aplicarAssinaturaPorPerfil }
  const asaas: any = {
    configurado: true,
    cancelarAssinatura: vi.fn(async () => (o.asaasFalha ? Promise.reject(new Error('fora')) : undefined)),
  }
  const lock: any = { comPerfil: vi.fn(async (_id: string, f: () => Promise<unknown>) => f()) }
  const chaves = new Set<string>()
  const correio: any = {
    ativo: true,
    enfileirar: vi.fn(async (a: any) => {
      if (a.chave && chaves.has(a.chave)) return false
      if (a.chave) chaves.add(a.chave)
      return true
    }),
  }
  const svc = new PartnersService(banco.prisma, profiles, correio, asaas, lock)
  return { ...banco, svc, reconciliar, correio, asaas, lock, aplicarAssinaturaPorPerfil }
}

type Montado = ReturnType<typeof montar>

/** Um parceiro já convidado, com conta e perfil próprios. */
async function convidado(m: Montado, perfil: Record<string, unknown> = {}) {
  const { user, perfil: p } = m.conta(perfil)
  const r = await m.svc.convidar(user.id, AGORA)
  return { user, perfil: p, partnerId: r.id }
}

async function ativo(m: Montado, perfil: Record<string, unknown> = {}) {
  const c = await convidado(m, perfil)
  await m.svc.aceitar(c.user.id, '203.0.113.9', { accepted: true }, AGORA)
  return c
}

/** Uma conta nova indicada pelo parceiro (como o cadastro a criaria). */
function indicada(m: Montado, partnerId: string, perfil: Record<string, unknown> = {}) {
  const c = m.conta(perfil)
  m.t.partnerReferral.push({
    id: m.novoId('partnerReferral'),
    partnerId,
    referredUserId: c.user.id,
    attributedAt: AGORA,
    convertedAt: null,
    disqualifiedAt: null,
    disqualificationReason: '',
    createdAt: AGORA,
    updatedAt: AGORA,
  })
  return c
}

const membro = (m: Montado, id: string) => m.t.partnerMembership.find((x) => x.id === id)!
const recompensas = (m: Montado, partnerId: string) => m.t.partnerReward.filter((r) => r.partnerId === partnerId)

describe('convite e aceite', () => {
  let m: Montado
  beforeEach(() => {
    m = montar()
  })

  it('o convite nasce "invited", com código sorteado que não deriva de nada da pessoa', async () => {
    const c = await convidado(m, { name: 'Marina Sales', slug: 'marina-sales', oabNumber: 'SP 123456' })
    const p = membro(m, c.partnerId)
    expect(p.status).toBe('invited')
    expect(p.referralCode).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(p.referralCode.toLowerCase()).not.toContain('marina')
    expect(p.referralCode).not.toContain('123456')
    expect(p.benefitUntil).toBeNull()
    expect(m.correio.enfileirar).toHaveBeenCalledWith(expect.objectContaining({ modelo: 'parceiro-convidado', chave: `partner-invite:${c.partnerId}` }))
  })

  it('convidado ainda não tem benefício: o plano efetivo não sobe', async () => {
    const c = await convidado(m)
    membro(m, c.partnerId).benefitUntil = dias(30) // nem com prazo gravado
    expect(planoVigente({ ...c.perfil, partner: membro(m, c.partnerId) }, AGORA)).toBe('free')
  })

  it('FREE aceita: 45 dias de MAX efetivo, plano contratado intocado, aceite registrado', async () => {
    const c = await ativo(m)
    const p = membro(m, c.partnerId)
    expect(p.status).toBe('active')
    expect(p.benefitUntil.getTime()).toBe(dias(45).getTime())
    expect(p.termsVersion).toBe(PARTNER_TERMS_VERSION)
    expect(p.termsAcceptedAt.getTime()).toBe(AGORA.getTime())
    expect(p.termsIp).toBe('203.0.113.9')
    // O financeiro é do perfil, e o programa não escreve nele.
    expect(c.perfil.plan).toBe('free')
    expect(planoVigente({ ...c.perfil, partner: p }, AGORA)).toBe('premium')
    expect(recompensas(m, c.partnerId)).toEqual([
      expect.objectContaining({ key: `initial:${c.partnerId}`, type: 'initial', status: 'confirmed', days: 45 }),
    ])
    expect(m.reconciliar).toHaveBeenCalledWith(c.perfil.id, 'free', expect.any(String), AGORA)
  })

  it('PRO aceita: continua PRO no financeiro, MAX no efetivo, e o painel diz que a assinatura segue', async () => {
    const c = await ativo(m, { plan: 'pro', planStatus: 'active', currentPeriodEnd: dias(20) })
    expect(c.perfil.plan).toBe('pro')
    expect(planoVigente({ ...c.perfil, partner: membro(m, c.partnerId) }, AGORA)).toBe('premium')
    const painel: any = await m.svc.painel(c.user.id, {}, AGORA)
    expect(painel.planoFinanceiro).toBe('pro')
    expect(painel.avisos.pro).toBe(AVISO_PRO)
    // E ao fim do prazo, volta ao PRO — não ao Free.
    expect(planoVigente({ ...c.perfil, currentPeriodEnd: dias(80), partner: membro(m, c.partnerId) }, dias(46))).toBe('pro')
  })

  it('MAX com renovação: o aceite encerra a renovação, e os 45 dias começam no fim do período pago', async () => {
    const c = await convidado(m, { plan: 'premium', planStatus: 'active', currentPeriodEnd: dias(10), billingSubscriptionId: 'sub_max' })
    const painel: any = await m.svc.painel(c.user.id, {}, AGORA)
    expect(painel.bloqueio).toBeNull()
    expect(painel.renovacao).toMatch(/renovação é encerrada/)
    await m.svc.aceitar(c.user.id, '1.1.1.1', { accepted: true }, AGORA)
    expect(m.asaas.cancelarAssinatura).toHaveBeenCalledWith('sub_max')
    expect(m.lock.comPerfil).toHaveBeenCalledWith(c.perfil.id, expect.any(Function))
    // Cancelada SEM devolução: o mês pago continua, e nada mais é cobrado.
    expect(c.perfil).toMatchObject({ plan: 'premium', planStatus: 'canceled' })
    expect((c.perfil as any).currentPeriodEnd.getTime()).toBe(dias(10).getTime())
    expect(membro(m, c.partnerId).benefitUntil.getTime()).toBe(dias(10 + 45).getTime())
  })

  it('PRO com renovação: o aceite encerra a renovação e o MAX do programa começa agora', async () => {
    const c = await convidado(m, { plan: 'pro', planStatus: 'active', currentPeriodEnd: dias(20), billingSubscriptionId: 'sub_pro' })
    expect(((await m.svc.painel(c.user.id, {}, AGORA)) as any).renovacao).toMatch(/PRO.*renovação é encerrada/)
    await m.svc.aceitar(c.user.id, '1.1.1.1', { accepted: true }, AGORA)
    expect(m.asaas.cancelarAssinatura).toHaveBeenCalledWith('sub_pro')
    expect(c.perfil.planStatus).toBe('canceled')
    expect(membro(m, c.partnerId).benefitUntil.getTime()).toBe(dias(45).getTime())
    const painel: any = await m.svc.painel(c.user.id, {}, AGORA)
    // A assinatura não renova mais: o painel não diz que o PRO "continua sendo cobrado".
    expect(painel.avisos.pro).toBeNull()
  })

  it('Asaas fora do ar no aceite: nada é ativado, nada é cancelado aqui, e a pessoa tenta de novo', async () => {
    const f = montar({ asaasFalha: true })
    const c = await convidado(f, { plan: 'pro', planStatus: 'active', currentPeriodEnd: dias(20), billingSubscriptionId: 'sub_pro' })
    await expect(f.svc.aceitar(c.user.id, '1.1.1.1', { accepted: true }, AGORA)).rejects.toMatchObject({ status: 503 })
    expect(membro(f, c.partnerId).status).toBe('invited')
    expect(c.perfil.planStatus).toBe('active')
    expect(f.aplicarAssinaturaPorPerfil).not.toHaveBeenCalled()
  })

  it('e-mail não confirmado (com o correio ligado): o aceite espera a confirmação', async () => {
    const c = await convidado(m)
    c.user.emailVerifiedAt = null
    await expect(m.svc.aceitar(c.user.id, '1.1.1.1', { accepted: true }, AGORA)).rejects.toMatchObject({ status: 403 })
    expect(membro(m, c.partnerId).status).toBe('invited')
  })

  it('MAX dado pelo escritório (sem término) também não aceita, com a explicação certa', async () => {
    const c = await convidado(m, { plan: 'premium', planStatus: 'active', currentPeriodEnd: null, firmMembership: { status: 'active' } })
    await expect(m.svc.aceitar(c.user.id, '1.1.1.1', { accepted: true }, AGORA)).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/escritório/),
    })
  })

  it('MAX cancelado com período pago no futuro: os 45 dias começam no fim do que já foi pago', async () => {
    const c = await ativo(m, { plan: 'premium', planStatus: 'canceled', currentPeriodEnd: dias(12) })
    expect(membro(m, c.partnerId).benefitUntil.getTime()).toBe(dias(12 + 45).getTime())
  })

  it('aceitar duas vezes (ou ao mesmo tempo) não dá 90 dias', async () => {
    const c = await convidado(m)
    await Promise.all([
      m.svc.aceitar(c.user.id, '1.1.1.1', { accepted: true }, AGORA),
      m.svc.aceitar(c.user.id, '1.1.1.1', { accepted: true }, AGORA),
    ])
    await m.svc.aceitar(c.user.id, '1.1.1.1', { accepted: true }, AGORA)
    expect(recompensas(m, c.partnerId).filter((r) => r.type === 'initial')).toHaveLength(1)
    expect(membro(m, c.partnerId).benefitUntil.getTime()).toBe(dias(45).getTime())
  })

  it('sem o "aceito", ou com a versão das regras desatualizada, recusa', async () => {
    const c = await convidado(m)
    await expect(m.svc.aceitar(c.user.id, '1.1.1.1', { accepted: 'true' }, AGORA)).rejects.toMatchObject({ status: 400 })
    await expect(m.svc.aceitar(c.user.id, '1.1.1.1', { accepted: true, termsVersion: '2020-01-01' }, AGORA)).rejects.toMatchObject({ status: 409 })
    expect(membro(m, c.partnerId).status).toBe('invited')
  })

  it('não parceiro: painel 404 e resumo vazio — nada a ver com a conta de outra pessoa', async () => {
    await ativo(m)
    const estranho = m.conta()
    await expect(m.svc.painel(estranho.user.id, {}, AGORA)).rejects.toMatchObject({ status: 404 })
    await expect(m.svc.aceitar(estranho.user.id, '1.1.1.1', { accepted: true }, AGORA)).rejects.toMatchObject({ status: 404 })
    expect(await m.svc.resumo(estranho.user.id, AGORA)).toEqual({ status: null, benefitUntil: null, activeBenefit: false })
  })

  it('convite repetido e convite de participação encerrada são recusados', async () => {
    const c = await convidado(m)
    await expect(m.svc.convidar(c.user.id, AGORA)).rejects.toMatchObject({ status: 409 })
    await m.svc.encerrar(c.partnerId, 'fim do teste', AGORA)
    await expect(m.svc.convidar(c.user.id, AGORA)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/definitivo/) })
  })
})

describe('conversão: só o primeiro pagamento real, uma vez', () => {
  let m: Montado
  let parceiro: Awaited<ReturnType<typeof ativo>>
  beforeEach(async () => {
    m = montar()
    parceiro = await ativo(m)
  })

  const pagar = (profileId: string, extra: Record<string, unknown> = {}) =>
    m.svc.registrarConversao({ profileId, plan: 'pro', amount: 29, paymentId: 'pay_001', occurredAt: AGORA, ...extra }, AGORA)

  it('cadastro gratuito não gera nada: a indicação fica em "cadastro realizado"', async () => {
    indicada(m, parceiro.partnerId)
    const painel: any = await m.svc.painel(parceiro.user.id, {}, AGORA)
    expect(painel.totais).toEqual({ cadastrados: 1, conversoes: 0, pendentes: 0, revogadas: 0 })
    expect(painel.indicacoes.itens[0].situacao).toBe('cadastro')
    expect(recompensas(m, parceiro.partnerId).filter((r) => r.type === 'referral')).toHaveLength(0)
  })

  it('primeiro PRO pago → recompensa pendente de 30 dias, elegível em 7 dias, sem mexer no prazo', async () => {
    const c = indicada(m, parceiro.partnerId)
    const antes = membro(m, parceiro.partnerId).benefitUntil.getTime()
    expect(await pagar(c.perfil.id, { billingEventId: 'be1' })).toBe('criada')
    const [r] = recompensas(m, parceiro.partnerId).filter((x) => x.type === 'referral')
    expect(r).toMatchObject({ status: 'pending', days: 30, sourcePaymentId: 'pay_001', sourceBillingEventId: 'be1' })
    expect(r!.key).toMatch(/^referral:/)
    // Fim do 7º dia em Brasília (o mesmo relógio do arrependimento): 14/10 às 23:59:59.999.
    expect(r!.eligibleAt.toISOString()).toBe('2026-10-15T02:59:59.999Z')
    expect(membro(m, parceiro.partnerId).benefitUntil.getTime()).toBe(antes)
    expect(m.correio.enfileirar).toHaveBeenCalledWith(expect.objectContaining({ modelo: 'parceiro-conversao-pendente' }))
  })

  it('primeiro MAX pago também → os mesmos 30 dias', async () => {
    const c = indicada(m, parceiro.partnerId)
    expect(await pagar(c.perfil.id, { plan: 'premium', amount: 49 })).toBe('criada')
    expect(recompensas(m, parceiro.partnerId).find((x) => x.type === 'referral')!.days).toBe(30)
  })

  it('valor divergente, plano Free ou sem id de pagamento: ignorado', async () => {
    const c = indicada(m, parceiro.partnerId)
    expect(await pagar(c.perfil.id, { amount: 1 })).toBe('ignorada')
    expect(await pagar(c.perfil.id, { plan: 'free' })).toBe('ignorada')
    expect(await pagar(c.perfil.id, { paymentId: '' })).toBe('ignorada')
    expect(recompensas(m, parceiro.partnerId).filter((x) => x.type === 'referral')).toHaveLength(0)
  })

  it('CONFIRMED e RECEIVED do mesmo pagamento (ids de evento diferentes) não duplicam', async () => {
    const c = indicada(m, parceiro.partnerId)
    expect(await pagar(c.perfil.id, { billingEventId: 'evt_confirmed' })).toBe('criada')
    expect(await pagar(c.perfil.id, { billingEventId: 'evt_received' })).toBe('repetida')
    expect(recompensas(m, parceiro.partnerId).filter((x) => x.type === 'referral')).toHaveLength(1)
  })

  it('checkout imediato e webhook ao mesmo tempo: uma recompensa só', async () => {
    const c = indicada(m, parceiro.partnerId)
    const r = await Promise.all([pagar(c.perfil.id), pagar(c.perfil.id, { billingEventId: 'evt_1' })])
    expect(r.sort()).toEqual(['criada', 'repetida'])
    expect(recompensas(m, parceiro.partnerId).filter((x) => x.type === 'referral')).toHaveLength(1)
  })

  it('renovação mensal (outro pagamento) não cria nova recompensa', async () => {
    const c = indicada(m, parceiro.partnerId)
    await pagar(c.perfil.id)
    expect(await pagar(c.perfil.id, { paymentId: 'pay_002', occurredAt: dias(30) })).toBe('repetida')
    expect(recompensas(m, parceiro.partnerId).filter((x) => x.type === 'referral')).toHaveLength(1)
  })

  it('conta sem indicação: nada acontece', async () => {
    const solta = m.conta()
    expect(await pagar(solta.perfil.id)).toBe('sem-indicacao')
  })

  it('parceiro suspenso no momento do pagamento: a conversão é marcada e não rende nada, nem depois', async () => {
    const c = indicada(m, parceiro.partnerId)
    await m.svc.suspender(parceiro.partnerId, 'investigação', AGORA)
    expect(await pagar(c.perfil.id)).toBe('nao-elegivel')
    await m.svc.reativar(parceiro.partnerId, AGORA)
    expect(await pagar(c.perfil.id, { paymentId: 'pay_002' })).toBe('repetida')
    expect(recompensas(m, parceiro.partnerId).filter((x) => x.type === 'referral')).toHaveLength(0)
  })

  it('autoindicação nunca rende', async () => {
    const ref = m.t.partnerReferral
    ref.push({ id: m.novoId('partnerReferral'), partnerId: parceiro.partnerId, referredUserId: parceiro.user.id, attributedAt: AGORA, convertedAt: null, disqualifiedAt: null, disqualificationReason: '' })
    expect(await pagar(parceiro.perfil.id)).toBe('nao-elegivel')
  })
})

describe('validação, confirmação e corrida', () => {
  let m: Montado
  let parceiro: Awaited<ReturnType<typeof ativo>>
  beforeEach(async () => {
    m = montar()
    parceiro = await ativo(m)
  })

  async function pendente(paymentId: string) {
    const c = indicada(m, parceiro.partnerId)
    await m.svc.registrarConversao({ profileId: c.perfil.id, plan: 'pro', amount: 29, paymentId, occurredAt: AGORA }, AGORA)
    return m.t.partnerReward.find((r) => r.sourcePaymentId === paymentId)!
  }

  it('antes dos 7 dias não confirma; depois, soma 30 a partir do prazo que existe', async () => {
    const r = await pendente('pay_a')
    expect(await m.svc.confirmarRecompensa(r.id, dias(6))).toBe('cedo')
    expect(await m.svc.confirmarPendentes(dias(7))).toBe(0) // ainda dentro do 7º dia
    expect(await m.svc.confirmarPendentes(dias(8))).toBe(1)
    expect(r.status).toBe('confirmed')
    // 45 iniciais ainda correndo no dia 7: soma a partir do dia 45.
    expect(membro(m, parceiro.partnerId).benefitUntil.getTime()).toBe(dias(75).getTime())
    expect(m.correio.enfileirar).toHaveBeenCalledWith(expect.objectContaining({ modelo: 'parceiro-beneficio-prorrogado', chave: `partner-confirmed:${r.id}` }))
  })

  it('com o benefício já vencido, soma a partir de agora', async () => {
    const r = await pendente('pay_a')
    membro(m, parceiro.partnerId).benefitUntil = dias(-3)
    await m.svc.confirmarRecompensa(r.id, dias(8))
    expect(membro(m, parceiro.partnerId).benefitUntil.getTime()).toBe(dias(38).getTime())
  })

  it('duas indicações amadurecendo ao mesmo tempo não perdem dias (compare-and-swap)', async () => {
    const a = await pendente('pay_a')
    const b = await pendente('pay_b')
    const r = await Promise.all([m.svc.confirmarRecompensa(a.id, dias(8)), m.svc.confirmarRecompensa(b.id, dias(8))])
    expect(r).toEqual(['confirmada', 'confirmada'])
    expect(membro(m, parceiro.partnerId).benefitUntil.getTime()).toBe(dias(45 + 60).getTime())
  })

  it('a mesma recompensa confirmada duas vezes em paralelo soma uma vez', async () => {
    const a = await pendente('pay_a')
    await Promise.all([m.svc.confirmarRecompensa(a.id, dias(8)), m.svc.confirmarRecompensa(a.id, dias(8))])
    expect(membro(m, parceiro.partnerId).benefitUntil.getTime()).toBe(dias(75).getTime())
  })

  it('participação suspensa: a recompensa espera; reativada, amadurece', async () => {
    const r = await pendente('pay_a')
    await m.svc.suspender(parceiro.partnerId, 'investigação', AGORA)
    expect(await m.svc.confirmarPendentes(dias(8))).toBe(0)
    expect(r.status).toBe('pending')
    await m.svc.reativar(parceiro.partnerId, dias(9))
    expect(await m.svc.confirmarPendentes(dias(9))).toBe(1)
  })
})

describe('estorno e chargeback', () => {
  let m: Montado
  let parceiro: Awaited<ReturnType<typeof ativo>>
  beforeEach(async () => {
    m = montar()
    parceiro = await ativo(m)
  })

  async function pendente(paymentId = 'pay_a') {
    const c = indicada(m, parceiro.partnerId)
    await m.svc.registrarConversao({ profileId: c.perfil.id, plan: 'pro', amount: 29, paymentId, occurredAt: AGORA }, AGORA)
    return m.t.partnerReward.find((r) => r.sourcePaymentId === paymentId)!
  }

  it('estorno durante a validação: revogada, sem dia nenhum', async () => {
    const r = await pendente()
    const antes = membro(m, parceiro.partnerId).benefitUntil.getTime()
    expect(await m.svc.revogarPorPagamento('pay_a', 'estorno', dias(2))).toBe('revogada')
    expect(r.status).toBe('revoked')
    expect(await m.svc.confirmarPendentes(dias(8))).toBe(0)
    expect(membro(m, parceiro.partnerId).benefitUntil.getTime()).toBe(antes)
  })

  it('chargeback durante a validação: a mesma revogação', async () => {
    const r = await pendente()
    await m.svc.revogarPorPagamento('pay_a', 'contestação do pagamento', dias(1))
    expect(r).toMatchObject({ status: 'revoked', reason: 'contestação do pagamento' })
  })

  it('estorno depois de confirmada: tira os 30 dias uma vez só, mesmo repetido', async () => {
    const r = await pendente()
    await m.svc.confirmarRecompensa(r.id, dias(8))
    expect(membro(m, parceiro.partnerId).benefitUntil.getTime()).toBe(dias(75).getTime())
    expect(await m.svc.revogarPorPagamento('pay_a', 'estorno', dias(10))).toBe('revogada')
    expect(await m.svc.revogarPorPagamento('pay_a', 'estorno', dias(10))).toBe('repetida')
    await Promise.all([m.svc.revogarPorPagamento('pay_a', 'estorno', dias(10)), m.svc.revogarPorPagamento('pay_a', 'estorno', dias(10))])
    expect(membro(m, parceiro.partnerId).benefitUntil.getTime()).toBe(dias(45).getTime())
    expect(r.status).toBe('revoked')
  })

  it('o desconto nunca deixa o prazo antes de agora', async () => {
    const r = await pendente()
    await m.svc.confirmarRecompensa(r.id, dias(8))
    membro(m, parceiro.partnerId).benefitUntil = dias(20)
    await m.svc.revogarPorPagamento('pay_a', 'estorno', dias(10))
    expect(membro(m, parceiro.partnerId).benefitUntil.getTime()).toBe(dias(10).getTime())
    expect(descontar(dias(5), 30, dias(10))!.getTime()).toBe(dias(5).getTime()) // vencido: nada a tirar
    expect(descontar(null, 30, AGORA)).toBeNull()
    expect(prorrogar(dias(-5), 30, AGORA).getTime()).toBe(dias(30).getTime())
  })

  it('pagamento sem recompensa: nada a revogar', async () => {
    expect(await m.svc.revogarPorPagamento('pay_desconhecido', 'estorno', AGORA)).toBe('sem-recompensa')
  })
})

describe('suspensão, reativação e encerramento', () => {
  let m: Montado
  let parceiro: Awaited<ReturnType<typeof ativo>>
  beforeEach(async () => {
    m = montar()
    parceiro = await ativo(m)
  })

  it('suspenso: o benefício para de elevar o plano na hora, o código não atribui e o relógio corre', async () => {
    await m.svc.suspender(parceiro.partnerId, 'investigação', AGORA)
    const p = membro(m, parceiro.partnerId)
    expect(p.status).toBe('suspended')
    expect(p.benefitUntil.getTime()).toBe(dias(45).getTime())
    expect(planoVigente({ ...parceiro.perfil, partner: p }, AGORA)).toBe('free')
    const req = requisicao()
    expect(await m.svc.capturarAtribuicao(req as any, p.referralCode)).toEqual({ accepted: false })
    expect(req.gravados).toHaveLength(0)
    expect(m.reconciliar).toHaveBeenLastCalledWith(parceiro.perfil.id, 'premium', expect.any(String), AGORA)
  })

  it('reativar devolve só o que restou: os dias da suspensão não voltam', async () => {
    await m.svc.suspender(parceiro.partnerId, 'investigação', AGORA)
    await m.svc.reativar(parceiro.partnerId, dias(10))
    const p = membro(m, parceiro.partnerId)
    expect(p.status).toBe('active')
    expect(p.benefitUntil.getTime()).toBe(dias(45).getTime())
    expect(planoVigente({ ...parceiro.perfil, partner: p }, dias(10))).toBe('premium')
    expect(planoVigente({ ...parceiro.perfil, partner: p }, dias(46))).toBe('free')
  })

  it('encerrado: definitivo, pendentes revogadas, histórico preservado, sem link no painel', async () => {
    const c = indicada(m, parceiro.partnerId)
    await m.svc.registrarConversao({ profileId: c.perfil.id, plan: 'pro', amount: 29, paymentId: 'pay_a' }, AGORA)
    await m.svc.encerrar(parceiro.partnerId, 'fraude', AGORA)
    expect(membro(m, parceiro.partnerId).status).toBe('ended')
    expect(m.t.partnerReferral.filter((r) => r.partnerId === parceiro.partnerId)).toHaveLength(1)
    expect(recompensas(m, parceiro.partnerId).map((r) => r.status).sort()).toEqual(['confirmed', 'revoked'])
    const painel: any = await m.svc.painel(parceiro.user.id, {}, AGORA)
    expect(painel.status).toBe('ended')
    expect(painel.referralUrl).toBeNull()
    expect(painel.indicacoes.itens).toHaveLength(1)
    await expect(m.svc.reativar(parceiro.partnerId, AGORA)).rejects.toMatchObject({ status: 400 })
    expect(m.correio.enfileirar).toHaveBeenCalledWith(expect.objectContaining({ modelo: 'parceiro-encerrado', chave: `partner-ended:${parceiro.partnerId}` }))
  })

  it('ajuste manual entra no livro e mexe no prazo pelo mesmo compare-and-swap', async () => {
    await m.svc.ajustar(parceiro.partnerId, 10, 'cortesia de suporte', AGORA)
    expect(membro(m, parceiro.partnerId).benefitUntil.getTime()).toBe(dias(55).getTime())
    await m.svc.ajustar(parceiro.partnerId, -100, 'correção', AGORA)
    expect(membro(m, parceiro.partnerId).benefitUntil.getTime()).toBe(AGORA.getTime())
    expect(recompensas(m, parceiro.partnerId).filter((r) => r.type === 'manual').map((r) => r.days)).toEqual([10, -100])
    await expect(m.svc.ajustar(parceiro.partnerId, 0, 'nada', AGORA)).rejects.toMatchObject({ status: 400 })
    await expect(m.svc.ajustar(parceiro.partnerId, 1.5, 'meio dia', AGORA)).rejects.toMatchObject({ status: 400 })
  })

  it('corrigir o parceiro de uma indicação: só antes de converter, só para parceiro ativo', async () => {
    const outro = await ativo(m)
    const c = indicada(m, parceiro.partnerId)
    const ref = m.t.partnerReferral.find((r) => r.referredUserId === c.user.id)!
    await expect(m.svc.reatribuir(ref.id, outro.partnerId)).resolves.toMatchObject({ depois: { partnerId: outro.partnerId } })
    await m.svc.registrarConversao({ profileId: c.perfil.id, plan: 'pro', amount: 29, paymentId: 'pay_a' }, AGORA)
    await expect(m.svc.reatribuir(ref.id, parceiro.partnerId)).rejects.toMatchObject({ status: 400 })
    // Nunca para a própria conta indicada.
    const conta2 = indicada(m, parceiro.partnerId)
    const ref2 = m.t.partnerReferral.find((r) => r.referredUserId === conta2.user.id)!
    const doIndicado = await m.svc.convidar(conta2.user.id, AGORA)
    await m.svc.aceitar(conta2.user.id, '1.1.1.1', { accepted: true }, AGORA)
    await expect(m.svc.reatribuir(ref2.id, doIndicado.id)).rejects.toMatchObject({ status: 400 })
  })
})

describe('o que o parceiro vê', () => {
  it('nenhum dado de quem foi indicado — nem nome, e-mail, OAB, cidade, IP ou pagamento', async () => {
    const m = montar()
    const parceiro = await ativo(m)
    const c = indicada(m, parceiro.partnerId, { name: 'Fulana Indicada', oabNumber: 'RJ 987654', city: 'Niterói' })
    c.user.email = 'fulana@indicada.test'
    await m.svc.registrarConversao({ profileId: c.perfil.id, plan: 'premium', amount: 49, paymentId: 'pay_segredo_123' }, AGORA)
    const painel: any = await m.svc.painel(parceiro.user.id, {}, dias(1))
    const json = JSON.stringify(painel)
    for (const proibido of ['Fulana', 'fulana@indicada.test', '987654', 'Niterói', 'pay_segredo_123', c.user.id, c.perfil.id, '203.0.113.9']) {
      expect(json, proibido).not.toContain(proibido)
    }
    const item = painel.indicacoes.itens[0]
    expect(item.rotulo).toBe(rotuloDaIndicacao(item.id))
    expect(item.rotulo).toMatch(/^Indicação •••[A-Z0-9]{6}$/)
    expect(item.situacao).toBe('validacao')
    expect(painel.totais).toEqual({ cadastrados: 1, conversoes: 0, pendentes: 1, revogadas: 0 })
    expect(painel.aviso).toBe(AVISO_OBRIGATORIO)
    expect(painel.referralUrl).toMatch(/\/r\/[A-Za-z0-9_-]{22}$/)
  })

  it('a captura pública só diz aceito ou não — e nunca de quem é o código', async () => {
    const m = montar()
    const parceiro = await ativo(m, { name: 'Marina Sales' })
    const req = requisicao()
    const r = await m.svc.capturarAtribuicao(req as any, membro(m, parceiro.partnerId).referralCode)
    expect(Object.keys(r)).toEqual(['accepted'])
    expect(r.accepted).toBe(true)
    expect(JSON.stringify(r)).not.toMatch(/Marina|memb/)
    // Dois cookies, com o mesmo selo: o do cadastro e a marca de first-touch.
    expect(req.gravados.map((g) => [g.nome, g.opts.path])).toEqual([
      [REF_COOKIE, '/api/auth'],
      [REF_MARCA_COOKIE, '/api/partners/attribution'],
    ])
    expect(abrirAtribuicao(req.gravados[0]!.valor)?.partnerId).toBe(parceiro.partnerId)
    expect(req.gravados[0]!.opts).toMatchObject({ httpOnly: true, maxAgeMs: 30 * 24 * 60 * 60 * 1000 })
  })

  it('first-touch: com atribuição válida, outro código não sobrescreve; código inválido não apaga', async () => {
    const m = montar()
    const a = await ativo(m)
    const b = await ativo(m)
    const selo = selarAtribuicao(a.partnerId)
    const req = requisicao({ [REF_MARCA_COOKIE]: selo })
    expect(await m.svc.capturarAtribuicao(req as any, membro(m, b.partnerId).referralCode)).toEqual({ accepted: false })
    expect(await m.svc.capturarAtribuicao(req as any, 'codigo-que-nao-existe-123')).toEqual({ accepted: false })
    expect(await m.svc.capturarAtribuicao(req as any, '<script>')).toEqual({ accepted: false })
    expect(req.gravados).toHaveLength(0)
    expect(req.apagados).toHaveLength(0)
  })

  it('OAB igual só pede revisão humana, nunca bloqueia', () => {
    expect(normalizarOab('OAB/SP 123.456')).toBe('OABSP123456')
    expect(normalizarOab('')).toBe('')
  })
})

/** Contexto de requisição que registra o que seria gravado no navegador. */
function requisicao(cookies: Record<string, string> = {}) {
  const gravados: { nome: string; valor: string; opts: any }[] = []
  const apagados: { nome: string; opts: any }[] = []
  return {
    gravados,
    apagados,
    auth: {
      cookie: (n: string) => cookies[n],
      method: 'POST',
      setCookie: (nome: string, valor: string, opts: any) => gravados.push({ nome, valor, opts }),
      clearCookie: (nome: string, opts: any) => apagados.push({ nome, opts }),
    },
  }
}
