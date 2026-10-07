import { Body, Controller, ForbiddenException, Get, Headers, Ip, Post, Query, Req } from '@nestjs/common'
import { PartnersService } from './partners.service'
import { SessionService } from '../auth/session.service'
import { authDe, type RequisicaoComAuth } from '../auth/session-context'
import { origemPermitida } from '../auth/csrf'
import { clientIp } from '../security/net'
import { enforceRateLimit, PARTNER_RATE_RULES } from '../security/rate-limit'

/**
 * Programa Advocme Parceiros — o lado do advogado.
 *
 * Nada aqui é lido por ninguém além do próprio parceiro: o usuário vem SEMPRE da
 * sessão, nunca de um parâmetro, e não há rota que receba o id de outra
 * participação. O link do programa não aparece no perfil público, na página do
 * escritório nem em resposta pública alguma.
 */
@Controller('partners')
export class PartnersController {
  constructor(
    private readonly partners: PartnersService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * POST /api/partners/attribution  { code } → { accepted }
   *
   * Pública: quem abre o link ainda não tem conta. Grava um cookie assinado e
   * mais nada — não lê dado pessoal, não diz de quem é o código e, aceito ou não,
   * nunca atrapalha o cadastro que vem depois.
   */
  @Post('attribution')
  async atribuir(
    @Req() req: RequisicaoComAuth,
    @Body() body: { code?: unknown },
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
  ) {
    enforceRateLimit([[`parceiros:captura:${clientIp(ip, xff)}`, PARTNER_RATE_RULES.capturaPorIp]])
    // Sem sessão não há token anti-CSRF; a origem é o que resta, e basta: o
    // navegador não deixa outro site escrever o Origin.
    if (!origemPermitida(authDe(req).origin)) {
      throw new ForbiddenException('Pedido bloqueado por segurança: a origem da chamada não é reconhecida.')
    }
    return this.partners.capturarAtribuicao(req, body?.code)
  }

  /** GET /api/partners/me/resumo → { status, benefitUntil, activeBenefit } — o atalho do painel. */
  @Get('me/resumo')
  async resumo(@Req() req: RequisicaoComAuth) {
    const userId = await this.sessions.requireUser(req)
    enforceRateLimit([[`parceiros:painel:${userId}`, PARTNER_RATE_RULES.painelPorConta]])
    return this.partners.resumo(userId)
  }

  /** GET /api/partners/me?cursor=&limite= → o painel do parceiro (404 para quem não participa). */
  @Get('me')
  async painel(
    @Req() req: RequisicaoComAuth,
    @Query('cursor') cursor?: string,
    @Query('limite') limite?: string,
  ) {
    const userId = await this.sessions.requireUser(req)
    enforceRateLimit([[`parceiros:painel:${userId}`, PARTNER_RATE_RULES.painelPorConta]])
    return this.partners.painel(userId, { cursor, limite })
  }

  /** POST /api/partners/accept  { accepted: true, termsVersion? } — o aceite das regras. */
  @Post('accept')
  async aceitar(
    @Req() req: RequisicaoComAuth,
    @Body() body: { accepted?: unknown; termsVersion?: unknown },
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
  ) {
    const userId = await this.sessions.requireUser(req)
    enforceRateLimit([[`parceiros:aceite:${userId}`, PARTNER_RATE_RULES.aceitePorConta]])
    return this.partners.aceitar(userId, clientIp(ip, xff), body)
  }
}
