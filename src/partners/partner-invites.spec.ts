// Convite por e-mail e o relógio da validação.
//
//   • com conta: o convite vira participação na hora;
//   • sem conta: o convite espera o cadastro com o MESMO e-mail, e a pessoa recebe
//     o e-mail para criar a conta; repetido é recusado; vence em 90 dias;
//   • a validação da recompensa termina junto com o direito de arrependimento.

import { describe, expect, it, vi } from 'vitest'
import { bancoFalso } from '../../test/parceiros/banco-falso'
import { fimDaValidacao, PartnersService } from './partners.service'
import { converterConvitePendente, emailDoConvite, emailMascarado } from './partner-invites'
import { prazoDeArrependimento } from '../billing/minha-assinatura.service'
import { renderizar } from '../mail/modelos'

const AGORA = new Date('2026-10-07T12:00:00.000Z')
const DIA = 24 * 60 * 60 * 1000

function montar() {
  const banco = bancoFalso()
  const correio: any = { ativo: true, enfileirar: vi.fn(async () => true) }
  const svc = new PartnersService(banco.prisma, { reconciliarPlanoEfetivo: vi.fn() } as any, correio)
  return { ...banco, svc, correio }
}

describe('convite por e-mail', () => {
  it('e-mail com conta: vira participação convidada, como o convite pela conta', async () => {
    const m = montar()
    const { perfil } = m.conta({}, 'marina@exemplo.test')
    const r = await m.svc.convidarPorEmail('  Marina@Exemplo.TEST ', AGORA)
    expect(r).toMatchObject({ resultado: 'conta', email: 'm•••@exemplo.test' })
    expect(m.t.partnerMembership).toEqual([expect.objectContaining({ profileId: perfil.id, status: 'invited' })])
    expect(m.t.partnerInvite).toHaveLength(0)
    expect(m.correio.enfileirar).toHaveBeenCalledWith(expect.objectContaining({ modelo: 'parceiro-convidado' }))
  })

  it('e-mail sem conta: guarda o convite e manda o e-mail para criar a conta', async () => {
    const m = montar()
    const r = await m.svc.convidarPorEmail('nova@exemplo.test', AGORA)
    expect(r.resultado).toBe('email')
    expect(m.t.partnerInvite).toEqual([expect.objectContaining({ email: 'nova@exemplo.test' })])
    expect(m.t.partnerMembership).toHaveLength(0)
    expect(m.correio.enfileirar).toHaveBeenCalledWith({
      modelo: 'parceiro-convite-sem-conta',
      para: 'nova@exemplo.test',
      dados: {},
      chave: `partner-invite-email:${r.id}`,
    })
    await expect(m.svc.convidarPorEmail('NOVA@exemplo.test', AGORA)).rejects.toMatchObject({ status: 409 })
    await expect(m.svc.convidarPorEmail('sem-arroba', AGORA)).rejects.toMatchObject({ status: 400 })
  })

  it('o cadastro com o mesmo e-mail converte o convite em participação convidada (e apaga o convite)', async () => {
    const m = montar()
    await m.svc.convidarPorEmail('nova@exemplo.test', AGORA)
    const { perfil } = m.conta({}, 'nova@exemplo.test')
    const id = await converterConvitePendente(m.prisma, 'nova@exemplo.test', perfil.id, AGORA)
    expect(id).toBeTruthy()
    expect(m.t.partnerMembership).toEqual([expect.objectContaining({ id, profileId: perfil.id, status: 'invited' })])
    expect(m.t.partnerInvite).toHaveLength(0)
    // Nada é ativado no cadastro: o aceite continua sendo da pessoa.
    expect(m.t.partnerMembership[0]!.benefitUntil).toBeNull()
    // Outro e-mail não pega convite de ninguém.
    expect(await converterConvitePendente(m.prisma, 'outra@exemplo.test', perfil.id, AGORA)).toBeNull()
  })

  it('convite com mais de 90 dias não converte, e a varredura o apaga', async () => {
    const m = montar()
    await m.svc.convidarPorEmail('velha@exemplo.test', AGORA)
    const depois = new Date(AGORA.getTime() + 91 * DIA)
    const { perfil } = m.conta({}, 'velha@exemplo.test')
    expect(await converterConvitePendente(m.prisma, 'velha@exemplo.test', perfil.id, depois)).toBeNull()
    expect(m.t.partnerMembership).toHaveLength(0)
    await m.svc.convidarPorEmail('outra@exemplo.test', AGORA)
    expect(await m.svc.expurgarConvitesVencidos(depois)).toBe(1)
    expect(m.t.partnerInvite).toHaveLength(0)
  })

  it('o console lista e cancela convites; o e-mail vai mascarado para o histórico', async () => {
    const m = montar()
    const r = await m.svc.convidarPorEmail('nova@exemplo.test', AGORA)
    const lista = await m.svc.listarConvitesPorEmail(undefined, AGORA)
    expect(lista.itens).toEqual([expect.objectContaining({ id: r.id, email: 'nova@exemplo.test', vencido: false })])
    expect(await m.svc.cancelarConvitePorEmail(r.id)).toEqual({ antes: { email: 'n•••@exemplo.test' }, depois: null })
    expect(m.t.partnerInvite).toHaveLength(0)
    expect(emailMascarado('x@y.z')).toBe('x•••@y.z')
    expect(emailDoConvite('a@b')).toBeNull()
  })

  it('o e-mail fala de Parceiros (nunca "sócios"), leva ao cadastro e não promete nada antes do aceite', () => {
    const r = renderizar('parceiro-convite-sem-conta', {}, { site: 'https://site.test' })
    expect(r.texto).toContain('Programa Advocme Parceiros')
    expect(r.texto).not.toMatch(/s[óo]cio/i)
    expect(r.texto).toContain('https://site.test/criar-conta?next=%2Fparceiros')
    expect(r.texto).toMatch(/nada é ativado antes do seu aceite/)
    expect(r.texto).toMatch(/convidou este endereço para o Programa Advocme Parceiros/)
  })
})

describe('validação x arrependimento', () => {
  it('a recompensa só amadurece depois do último instante em que cancelar ainda devolve o dinheiro', () => {
    // Pago às 23:30 de 07/10 em Brasília (02:30Z do dia 08).
    const pagoEm = new Date('2026-10-08T02:30:00.000Z')
    const fimValidacao = fimDaValidacao(pagoEm)
    const fimArrependimento = prazoDeArrependimento(
      [{ id: 'pay_1', billingType: 'PIX', status: 'RECEIVED', dueDate: '2026-10-07', value: 29, confirmedDate: '2026-10-07' }],
      pagoEm,
    )!
    expect(fimValidacao.toISOString()).toBe('2026-10-15T02:59:59.999Z') // 14/10 23:59:59.999 em Brasília
    expect(fimValidacao.getTime()).toBeGreaterThanOrEqual(fimArrependimento.getTime())
  })
})
