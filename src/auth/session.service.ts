// Quem está falando com a API — e se essa sessão ainda vale.
//
// O token assinado prova que saiu daqui; a linha `Session` no banco prova que ela
// continua aberta. Essa segunda metade é o que permite cumprir o "sair": apagar a
// linha derruba aquele token na hora, mesmo que alguém tenha uma cópia.
//
// Custo: uma leitura por chave primária a cada requisição autenticada. Rotas
// autenticadas já falam com o banco de qualquer jeito, então não muda a ordem de
// grandeza — e é o preço de poder revogar.
//
// Uma linha por APARELHO: sair no celular não derruba o computador. Encerrar tudo
// de uma vez existe à parte (senha trocada, aparelho perdido).

import { Injectable, UnauthorizedException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { issueUserSession, sessionFromHeader, SESSION_TTL } from './user-auth'

@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) {}

  /** Abre uma sessão e devolve o token dela. */
  async issue(userId: string): Promise<{ token: string; expiresAt: number }> {
    // Higiene barata: as sessões vencidas deste usuário saem no login seguinte.
    // Sem isto a tabela só cresce, e sessão vencida é dado guardado à toa.
    await this.prisma.session
      .deleteMany({ where: { userId, expiresAt: { lt: new Date() } } })
      .catch(() => undefined)

    const expiresAt = Date.now() + SESSION_TTL
    const sessao = await this.prisma.session.create({
      data: { userId, expiresAt: new Date(expiresAt) },
      select: { id: true },
    })
    return issueUserSession(userId, sessao.id, expiresAt)
  }

  /**
   * Dono da requisição, ou null. Falha FECHADA: token estranho, sessão apagada,
   * sessão vencida e banco fora do ar dão todos o mesmo resultado — ninguém.
   */
  async userIdFrom(authorization?: string): Promise<string | null> {
    const payload = sessionFromHeader(authorization)
    if (!payload) return null
    try {
      const sessao = await this.prisma.session.findUnique({
        where: { id: payload.sessionId },
        select: { userId: true, expiresAt: true },
      })
      if (!sessao) return null
      // O token diz de quem é; a linha decide. Se divergirem, não vale.
      if (sessao.userId !== payload.userId) return null
      if (sessao.expiresAt.getTime() <= Date.now()) return null
      return sessao.userId
    } catch {
      return null
    }
  }

  /** Como `userIdFrom`, mas exige sessão: sem ela, 401. */
  async requireUser(authorization?: string, mensagem = 'Entre na sua conta.'): Promise<string> {
    const userId = await this.userIdFrom(authorization)
    if (!userId) throw new UnauthorizedException(mensagem)
    return userId
  }

  /** Encerra a sessão DESTE token (o aparelho que pediu para sair). */
  async revoke(authorization?: string): Promise<void> {
    const payload = sessionFromHeader(authorization)
    if (!payload) return
    await this.prisma.session
      .deleteMany({ where: { id: payload.sessionId, userId: payload.userId } })
      .catch(() => undefined)
  }

  /** Encerra TODAS as sessões do usuário (aparelho perdido, senha trocada). */
  async revokeAll(userId: string): Promise<number> {
    const { count } = await this.prisma.session.deleteMany({ where: { userId } })
    return count
  }

  /** Quantas sessões o usuário tem abertas agora (mostrado no painel da conta). */
  async countActive(userId: string): Promise<number> {
    return this.prisma.session.count({
      where: { userId, expiresAt: { gt: new Date() } },
    })
  }
}
