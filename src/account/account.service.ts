// Direitos do titular sobre os próprios dados (LGPD, art. 18): ver, levar embora
// e apagar. Sem isto, exercer o direito dependia de escrever para o suporte e
// alguém mexer no banco à mão — o que não é um direito, é um favor.
//
// Duas linhas que mandam no arquivo:
//
//   1. EXPORTAR É SÓ O QUE É DELE. Uma denúncia feita contra o perfil tem dois
//      titulares: o advogado denunciado e quem denunciou. O motivo e a data são
//      do primeiro; o e-mail e o texto de quem denunciou são do segundo — e
//      exportar isso entregaria, a quem foi denunciado, quem o denunciou.
//
//   2. APAGAR É APAGAR. Nada de marcar "inativo" e seguir guardando. O que fica
//      são registros que não são mais dele: uma denúncia some junto com o perfil,
//      mas o escritório em que ele era dono só é desfeito depois de devolver cada
//      membro ao plano individual que tinha antes.

import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { ProfilesService } from '../profiles/profiles.service'
import { verifyPassword } from '../auth/user-auth'

@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: ProfilesService,
  ) {}

  /**
   * Tudo o que a plataforma guarda sobre esta conta, em JSON legível — o formato
   * de portabilidade que a lei pede ("formato estruturado, de uso comum").
   */
  async exportData(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        createdAt: true,
        profile: {
          include: {
            areas: { orderBy: { order: 'asc' } },
            faqs: { orderBy: { order: 'asc' } },
            socials: true,
            auditLogs: { orderBy: { createdAt: 'desc' } },
            firmMembership: { include: { firm: { select: { name: true, slug: true } } } },
            // Denúncias: só o que diz respeito a ELE. Quem denunciou não entra.
            reports: {
              select: { reason: true, status: true, createdAt: true },
              orderBy: { createdAt: 'desc' },
            },
          },
        },
        firmsOwned: {
          select: { name: true, slug: true, city: true, state: true, createdAt: true },
        },
        tickets: {
          select: {
            kind: true,
            subject: true,
            message: true,
            status: true,
            adminNote: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
        sessions: { select: { createdAt: true, expiresAt: true } },
      },
    })
    if (!user) throw new UnauthorizedException('Sessão inválida.')

    const p = user.profile
    // Visitas são contadas sem identificar ninguém (nem do dono, nem de quem
    // visita) — por isso entram como número, não como lista de eventos.
    const visitas = p
      ? await this.prisma.linkEvent.count({ where: { profileId: p.id } })
      : 0

    // Histórico de cobrança. Entra na exportação porque é dado sobre a PESSOA — e
    // porque é justamente o que ela vai querer ver se algum dia discordar de uma
    // mudança de plano. Sem o payload cru: ele é a cópia do que o provedor mandou,
    // guardada para depuração e prova, e devolvê-lo aqui exportaria os
    // identificadores internos do provedor sem nenhum ganho para quem lê.
    const cobranca = p
      ? await this.prisma.billingEvent.findMany({
          where: { profileId: p.id },
          select: { type: true, occurredAt: true, applied: true, note: true, provider: true },
          orderBy: { occurredAt: 'desc' },
          take: 500,
        })
      : []

    return {
      geradoEm: new Date().toISOString(),
      sobre:
        'Tudo o que o advoc.me guarda sobre esta conta. Denúncias aparecem apenas ' +
        'pelo motivo e pela data: o contato de quem denunciou pertence a outra pessoa.',
      conta: { id: user.id, email: user.email, criadaEm: user.createdAt },
      perfil: p ?? null,
      escritoriosQueSaoSeus: user.firmsOwned,
      chamadosDeSuporte: user.tickets,
      sessoesAbertas: user.sessions,
      historicoDeCobranca: cobranca,
      estatisticas: { visitasAoPerfil: visitas },
      naoGuardamos: [
        'Dados de quem visita o seu perfil: o contato vai do aparelho do visitante direto para o seu WhatsApp.',
        'Sua senha em texto: guardamos apenas um hash scrypt, do qual ela não pode ser recuperada.',
        'Endereço IP de sessões: o IP é usado só na hora, para limitar tentativas, e não é gravado.',
        'Dados do seu cartão: quem os guarda é o provedor de pagamento. Aqui ficam só os identificadores da assinatura.',
      ],
    }
  }

  /**
   * Apaga a conta e tudo que depende dela. Exige a senha: excluir é irreversível,
   * e uma sessão esquecida num computador emprestado não pode bastar.
   *
   * O cascade do banco leva perfil, áreas, FAQ, redes, visitas, trilha de
   * auditoria, chamados, denúncias e sessões. O que o cascade NÃO sabe resolver é
   * o escritório: apagá-lo sem mais deixaria cada membro com o plano do escritório
   * que não existe mais.
   */
  async deleteAccount(userId: string, password: unknown) {
    const senha = typeof password === 'string' ? password : ''
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, password: true },
    })
    if (!user) throw new UnauthorizedException('Sessão inválida.')
    if (!senha || !verifyPassword(senha, user.password)) {
      throw new BadRequestException('Senha incorreta. A conta não foi excluída.')
    }

    await this.releaseOwnedFirms(userId)
    await this.prisma.user.delete({ where: { id: userId } })
    return { excluida: true as const }
  }

  /**
   * Devolve os membros dos escritórios do usuário ao plano individual que tinham
   * antes de entrar, para que a exclusão da conta do DONO não rebaixe em silêncio
   * o plano de outras pessoas. Mesma regra do "sair do escritório"
   * (firms.service → releaseMember); aqui vale para todos de uma vez.
   */
  private async releaseOwnedFirms(userId: string) {
    const firms = await this.prisma.firm.findMany({
      where: { ownerUserId: userId },
      select: {
        id: true,
        members: {
          where: { status: 'active' },
          select: { profileId: true, previousPlan: true, profile: { select: { userId: true } } },
        },
      },
    })
    for (const firm of firms) {
      for (const m of firm.members) {
        // O perfil do próprio dono some junto com a conta — não faz sentido
        // "devolver" plano para ele.
        if (m.profile.userId === userId) continue
        const volta = (m.previousPlan as 'free' | 'pro' | 'premium') ?? 'free'
        // Mesma porta do escritório e do webhook: devolver plano com um
        // `profile.update` cru deixava tema do Max e botão de agendar ligados num
        // perfil que voltou ao Free — o público prometendo o que o plano não tem.
        await this.profiles
          .aplicarAssinaturaPorPerfil(
            m.profileId,
            {
              plan: volta,
              planStatus: 'active',
              currentPeriodEnd: null,
              graceUntil: null,
              planScheduled: null,
            },
            `escritório encerrado pelo dono: ${volta}`,
          )
          // Um membro que falhe não pode impedir a exclusão da conta de quem pediu
          // (é direito da LGPD, art. 18) nem travar a devolução dos outros.
          .catch(() => undefined)
      }
    }
  }
}
