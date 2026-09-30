import { Body, Controller, Headers, HttpCode, Ip, Post, Req } from '@nestjs/common'
import { SessionService } from '../auth/session.service'
import type { RequisicaoComAuth } from '../auth/session-context'
import { CHECKOUT_RATE_RULES, enforceRateLimit } from '../security/rate-limit'
import { clientIp } from '../security/net'
import { CheckoutService } from './checkout.service'

/**
 * O checkout do advogado — as rotas que falam com o Asaas em nome de alguém logado.
 *
 * A sessão confere o CSRF sozinha (SessionService → assertCsrf) em todo pedido que
 * escreve, então estas rotas não precisam de nada além de exigir o login.
 *
 * ⚠️ O corpo de /assinar carrega número de cartão e CPF. Nada aqui registra o
 * corpo, e nada deve passar a registrar — ver asaas.api.ts.
 */
@Controller('billing')
export class CheckoutController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly sessions: SessionService,
  ) {}

  /** POST /api/billing/assinar — cria a assinatura no Asaas. */
  @Post('assinar')
  @HttpCode(200)
  async assinar(
    @Body() body: unknown,
    @Req() req: RequisicaoComAuth,
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
  ) {
    const userId = await this.sessions.requireUser(req, 'Entre na sua conta para assinar.')
    const origem = clientIp(ip, xff)
    enforceRateLimit(
      [
        [`checkout:conta:${userId}`, CHECKOUT_RATE_RULES.porConta],
        [`checkout:ip:${origem}`, CHECKOUT_RATE_RULES.porIp],
      ],
      'Muitas tentativas de pagamento em pouco tempo. Aguarde um pouco e tente de novo.',
    )
    // O IP vai ao Asaas porque ele exige o do CLIENTE na cobrança por cartão
    // (antifraude). Não é gravado aqui.
    return this.checkout.assinar(userId, body, origem)
  }

  /** POST /api/billing/cancelar — cancela a assinatura; quem pagou o mês tem o mês. */
  @Post('cancelar')
  @HttpCode(200)
  async cancelar(@Req() req: RequisicaoComAuth) {
    const userId = await this.sessions.requireUser(req, 'Entre na sua conta para cancelar.')
    return this.checkout.cancelar(userId)
  }
}
