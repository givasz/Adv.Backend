// A varredura do programa e o console.
//
//   • a varredura confirma, revoga, reconcilia e avisa — uma vez cada, em lote, e
//     uma linha problemática não para as outras;
//   • o console lê com parceiros:ler, decide com parceiros:gerir (que exige o
//     segundo fator), sempre com motivo e AdminAction; readonly não decide.

import { describe, expect, it, vi } from 'vitest'
import { ForbiddenException } from '@nestjs/common'
import { bancoFalso } from '../../test/parceiros/banco-falso'
import { PartnersService } from './partners.service'
import { PartnerMaintenanceService } from './partner-maintenance.service'
import { PartnersAdminController } from './partners-admin.controller'
import { decide, pode, type Permissao } from '../admin/admin-roles'
import { somarDias } from '../assinatura'

const AGORA = new Date('2026-10-07T12:00:00.000Z')
const dias = (n: number) => somarDias(AGORA, n)

async function montar() {
  const banco = bancoFalso()
  const reconciliar = vi.fn(async () => ({ mudou: true }))
  const chaves = new Set<string>()
  const correio: any = {
    enfileirar: vi.fn(async (a: any) => {
      if (chaves.has(a.chave)) return false
      chaves.add(a.chave)
      return true
    }),
  }
  const svc = new PartnersService(banco.prisma, { reconciliarPlanoEfetivo: reconciliar } as any, correio)
  const novo = async () => {
    const { user, perfil } = banco.conta()
    const { id } = await svc.convidar(user.id, AGORA)
    await svc.aceitar(user.id, '1.1.1.1', { accepted: true }, AGORA)
    return { user, perfil, id, m: banco.t.partnerMembership.find((x) => x.id === id)! }
  }
  return { ...banco, svc, reconciliar, correio, novo }
}

describe('varredura', () => {
  it('fim do benefício: reconcilia uma vez só, e só depois do vencimento', async () => {
    const b = await montar()
    const p = await b.novo()
    b.reconciliar.mockClear()
    expect(await b.svc.reconciliarVencidos(dias(44))).toBe(0)
    expect(await b.svc.reconciliarVencidos(dias(46))).toBe(1)
    expect(b.reconciliar).toHaveBeenCalledWith(p.perfil.id, 'premium', expect.stringMatching(/fim/), dias(46))
    expect(await b.svc.reconciliarVencidos(dias(47))).toBe(0)
    expect(b.reconciliar).toHaveBeenCalledTimes(1)
  })

  it('prorrogou depois de vencer: a próxima vez que vencer, reconcilia de novo', async () => {
    const b = await montar()
    const p = await b.novo()
    await b.svc.reconciliarVencidos(dias(46))
    await b.svc.ajustar(p.id, 10, 'cortesia', dias(46))
    expect(p.m.benefitReconciledAt).toBeNull()
    expect(await b.svc.reconciliarVencidos(dias(57))).toBe(1)
  })

  it('uma linha problemática não para o lote', async () => {
    const b = await montar()
    await b.novo()
    await b.novo()
    b.reconciliar.mockRejectedValueOnce(new Error('perfil quebrado'))
    expect(await b.svc.reconciliarVencidos(dias(46))).toBe(1)
    expect(await b.svc.reconciliarVencidos(dias(46))).toBe(1) // a que falhou volta na passada seguinte
  })

  it('aviso de fim: um por prazo, mesmo com várias passadas', async () => {
    const b = await montar()
    const p = await b.novo()
    expect(await b.svc.avisarExpirando(dias(30))).toBe(0)
    await b.svc.avisarExpirando(dias(39))
    await b.svc.avisarExpirando(dias(40))
    const avisos = b.correio.enfileirar.mock.calls.filter(([a]: any[]) => a.modelo === 'parceiro-beneficio-expirando')
    // Duas passadas tentaram, e a chave do correio deixou sair um aviso só.
    expect(avisos).toHaveLength(2)
    expect(new Set(avisos.map(([a]: any[]) => a.chave))).toEqual(new Set([`partner-expiring:${p.id}:${dias(45).toISOString()}`]))
  })

  it('a passada completa: confirma o maduro, revoga o de encerrado, reconcilia e não lança', async () => {
    const b = await montar()
    const a = await b.novo()
    const e = await b.novo()
    for (const [parceiro, pay] of [[a, 'pay_a'], [e, 'pay_e']] as const) {
      const c = b.conta()
      b.t.partnerReferral.push({ id: b.novoId('partnerReferral'), partnerId: parceiro.id, referredUserId: c.user.id, attributedAt: AGORA, convertedAt: null, disqualifiedAt: null, disqualificationReason: '' })
      await b.svc.registrarConversao({ profileId: c.perfil.id, plan: 'pro', amount: 29, paymentId: pay, occurredAt: AGORA }, AGORA)
    }
    // Encerrado "por fora" (como se a revogação do encerramento tivesse falhado).
    e.m.status = 'ended'
    const varredura = new PartnerMaintenanceService(b.svc)
    const r = await varredura.varrer(dias(8))
    expect(r).toMatchObject({ confirmadas: 1, revogadas: 1 })
    expect(b.t.partnerReward.find((x) => x.sourcePaymentId === 'pay_a')!.status).toBe('confirmed')
    expect(b.t.partnerReward.find((x) => x.sourcePaymentId === 'pay_e')!.status).toBe('revoked')
    expect(await varredura.varrer(dias(8))).toMatchObject({ confirmadas: 0, revogadas: 0 })
  })
})

describe('console', () => {
  /** AdminService de mentira com a MESMA regra da porta: permissão e segundo fator. */
  function admin(papel: string, totpPendente = false) {
    return {
      registrar: vi.fn(async () => undefined),
      exigirMotivo: (t?: string) => {
        if (!t || t.trim().length < 5) throw new Error('motivo')
        return t.trim()
      },
      exigir: vi.fn(async (_req: unknown, p: Permissao) => {
        if (!pode(papel, p)) throw new ForbiddenException('papel')
        if (decide(p) && totpPendente) throw new ForbiddenException('totp')
        return { id: 'a1', label: papel, role: papel }
      }),
    }
  }

  it('readonly lê a lista e a ficha, mas não convida, suspende nem ajusta', async () => {
    const b = await montar()
    const p = await b.novo()
    const adm = admin('readonly')
    const ctl = new PartnersAdminController(adm as any, b.svc)
    await expect(ctl.listar({} as any)).resolves.toMatchObject({ itens: [expect.objectContaining({ id: p.id })] })
    await expect(ctl.ficha(p.id, {} as any)).resolves.toMatchObject({ id: p.id })
    await expect(ctl.suspender(p.id, {} as any, { reason: 'motivo longo' })).rejects.toBeInstanceOf(ForbiddenException)
    await expect(ctl.ajustar(p.id, {} as any, { days: 5, reason: 'motivo longo' })).rejects.toBeInstanceOf(ForbiddenException)
    expect(adm.registrar).not.toHaveBeenCalled()
    expect(p.m.status).toBe('active')
  })

  it('suporte não abre nem a lista', async () => {
    const b = await montar()
    const ctl = new PartnersAdminController(admin('support') as any, b.svc)
    await expect(ctl.listar({} as any)).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('moderação sem segundo fator configurado não decide', async () => {
    const b = await montar()
    const p = await b.novo()
    const ctl = new PartnersAdminController(admin('moderator', true) as any, b.svc)
    await expect(ctl.suspender(p.id, {} as any, { reason: 'motivo longo' })).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('moderação com segundo fator decide, com motivo obrigatório e AdminAction minimizada', async () => {
    const b = await montar()
    const p = await b.novo()
    const adm = admin('moderator')
    const ctl = new PartnersAdminController(adm as any, b.svc)
    await expect(ctl.suspender(p.id, {} as any, { reason: '' })).rejects.toThrow('motivo')
    await ctl.suspender(p.id, {} as any, { reason: 'divulgação em massa' }, '1.1.1.1')
    expect(adm.registrar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'parceiro.suspender',
        targetType: 'partner',
        targetId: p.id,
        reason: 'divulgação em massa',
        before: { status: 'active', benefitUntil: dias(45).toISOString() },
        after: { status: 'suspended', benefitUntil: dias(45).toISOString() },
      }),
    )
    const outro = b.conta()
    await ctl.convidar(outro.user.id, {} as any, { reason: 'convite do responsável' })
    expect(adm.registrar).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ action: 'parceiro.convidar' }))
  })

  it('id fora do formato nem chega ao banco', async () => {
    const b = await montar()
    const ctl = new PartnersAdminController(admin('owner') as any, b.svc)
    await expect(ctl.ficha('../../etc', {} as any)).rejects.toMatchObject({ status: 404 })
  })

  it('a ficha mascara o pagamento e marca OAB igual só para revisão', async () => {
    const b = await montar()
    const p = await b.novo()
    p.perfil.oabNumber = 'SP 123456'
    const c = b.conta({ oabNumber: 'sp-123.456', name: 'Indicada' })
    b.t.partnerReferral.push({ id: b.novoId('partnerReferral'), partnerId: p.id, referredUserId: c.user.id, attributedAt: AGORA, convertedAt: null, disqualifiedAt: null, disqualificationReason: '' })
    await b.svc.registrarConversao({ profileId: c.perfil.id, plan: 'pro', amount: 29, paymentId: 'pay_123456789' }, AGORA)
    const ficha: any = await b.svc.fichaParaConsole(p.id, {}, AGORA)
    expect(ficha.indicacoes.itens[0].revisarOab).toBe(true)
    expect(ficha.recompensas.find((r: any) => r.type === 'referral').sourcePaymentId).toBe('•••456789')
    expect(JSON.stringify(ficha)).not.toContain('pay_123456789')
    expect(ficha.conta).toMatchObject({ planoFinanceiro: 'free', planoEfetivo: 'premium' })
  })
})
