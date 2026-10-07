// O convite por e-mail de quem ainda não tem conta vira participação no cadastro.
//
// Mesmo desenho de FirmInvite (auth.service.resolvePendingInvites): o console
// convida um e-mail, a pessoa cria a conta com ele, e o convite aparece no painel
// dela como PartnerMembership(invited). Nada é ativado aqui — o aceite das regras
// continua sendo um ato da pessoa, em /parceiros.
//
// Função solta, e não método de serviço: quem a chama é o AuthService, e ele não
// pode depender do módulo do programa (o programa depende da cobrança, que
// depende dos perfis). Nunca lança: o cadastro não pode cair por causa disto.

import { novoCodigo } from './partner-attribution'
import { CONVITE_POR_EMAIL_DIAS } from './partner-terms'

const DIA_MS = 24 * 60 * 60 * 1000

/** Validade do convite por e-mail, contada da criação. */
export function conviteVencido(criadoEm: Date, agora = new Date()): boolean {
  return agora.getTime() - criadoEm.getTime() > CONVITE_POR_EMAIL_DIAS * DIA_MS
}

/** "m•••@dominio.com" — para o histórico do console, que não guarda e-mail de terceiro inteiro. */
export function emailMascarado(email: string): string {
  const [nome, dominio] = email.split('@')
  if (!nome || !dominio) return '•••'
  return `${nome[0]}•••@${dominio}`
}

/** Normaliza o e-mail como o cadastro normaliza; inválido vira `null`. */
export function emailDoConvite(bruto: unknown): string | null {
  const email = typeof bruto === 'string' ? bruto.trim().toLowerCase().slice(0, 200) : ''
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
}

/** O mínimo do Prisma que a conversão usa. */
interface PrismaDoConvite {
  partnerInvite: {
    findUnique(a: { where: { email: string } }): Promise<{ id: string; createdAt: Date } | null>
    delete(a: { where: { id: string } }): Promise<unknown>
  }
  partnerMembership: {
    create(a: { data: { profileId: string; referralCode: string; status: 'invited' }; select: { id: true } }): Promise<{ id: string }>
  }
}

/**
 * A conta acabou de nascer com este e-mail: se havia convite pendente, vira
 * participação convidada. Devolve o id da participação, ou `null`.
 */
export async function converterConvitePendente(
  prisma: PrismaDoConvite,
  email: string,
  profileId: string,
  agora = new Date(),
): Promise<string | null> {
  try {
    const convite = await prisma.partnerInvite.findUnique({ where: { email } })
    if (!convite) return null
    if (conviteVencido(convite.createdAt, agora)) {
      await prisma.partnerInvite.delete({ where: { id: convite.id } }).catch(() => undefined)
      return null
    }
    const m = await prisma.partnerMembership.create({
      data: { profileId, referralCode: novoCodigo(), status: 'invited' },
      select: { id: true },
    })
    await prisma.partnerInvite.delete({ where: { id: convite.id } }).catch(() => undefined)
    return m.id
  } catch {
    return null
  }
}
