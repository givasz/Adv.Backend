import { Body, Controller, Get, Headers, HttpCode, Ip, Param, Post, Req } from '@nestjs/common'
import { AnalyticsService } from './analytics.service'
import { PrismaService } from '../prisma/prisma.service'
import { SessionService } from '../auth/session.service'
import type { RequisicaoComAuth } from '../auth/session-context'
import { clientIp } from '../security/net'
import { checkRateLimit } from '../security/rate-limit'
import type { Plan } from '../plans'

@Controller()
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * POST /api/profiles/:slug/evento  { evento }  (PÚBLICO, sem sessão)
   *
   * A porta por onde o perfil avisa que alguém tocou num botão. Pública porque
   * quem toca é o visitante, que não tem conta nem deve ter.
   *
   * Responde 204 SEMPRE — inclusive quando o evento é recusado.
   *
   * Não é preguiça: um 404 aqui diria a quem perguntasse quais slugs existem, e
   * um 400 diria quais tipos de evento são válidos. Nenhuma das duas informações
   * ajuda o visitante (que nem vê esta resposta — ela sai por `sendBeacon`,
   * disparado e esquecido) e as duas ajudam quem estiver sondando. Como o
   * chamador legítimo ignora o corpo, não há nada a perder em calar.
   *
   * O IP entra só como CHAVE do limitador, e some no mesmo instante — nada dele
   * é gravado. Ver o cabeçalho de eventos.ts.
   */
  @Post('profiles/:slug/evento')
  @HttpCode(204)
  async registrar(
    @Param('slug') slug: string,
    @Body() body: { evento?: string },
    @Ip() ip?: string,
    @Headers('x-forwarded-for') forwardedFor?: string,
  ): Promise<void> {
    const chave = `evento:${clientIp(ip, forwardedFor)}`
    // Teto generoso: uma pessoa lendo um perfil e tocando em dois ou três botões
    // gera meia dúzia de eventos, e um escritório inteiro pode sair pelo mesmo
    // IP. O que este limite barra é o laço de terminal que encheria a tabela de
    // outra pessoa — não o uso real.
    //
    // `checkRateLimit` e não `enforceRateLimit`: estourar aqui não é erro que se
    // conte a alguém, é evento que se descarta.
    if (!checkRateLimit(chave, { windowMs: 60_000, max: 60 })) return
    if (!checkRateLimit(chave, { windowMs: 3_600_000, max: 600 })) return

    await this.analytics.registrar(slug, body?.evento)
  }

  /**
   * GET /api/analytics/me — o resumo do próprio perfil.
   *
   * O plano é lido do BANCO, nunca do que a requisição diz. Foi assim que a rota
   * de IA vazou recurso pago um dia (ver SEGURANCA.md, item 4): bastava mandar
   * `plan: "premium"` no corpo.
   */
  @Get('analytics/me')
  async minhas(@Req() req: RequisicaoComAuth) {
    const userId = await this.sessions.requireUser(
      req,
      'Entre na sua conta para ver as visitas do seu perfil.',
    )
    const perfil = await this.prisma.profile.findUnique({
      where: { userId },
      select: { plan: true },
    })
    return this.analytics.resumoDoDono(userId, (perfil?.plan as Plan) ?? 'free')
  }
}
