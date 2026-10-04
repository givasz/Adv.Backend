import { Body, Controller, Get, Headers, HttpCode, Ip, Post, Req } from '@nestjs/common'
import { SessionService } from '../auth/session.service'
import type { RequisicaoComAuth } from '../auth/session-context'
import { CHECKOUT_RATE_RULES, enforceRateLimit } from '../security/rate-limit'
import { clientIp } from '../security/net'
import { CheckoutService } from './checkout.service'
import { MinhaAssinaturaService } from './minha-assinatura.service'
import { BillingLockService } from './billing-lock'

/**
 * As rotas da assinatura paga — assinar, ver, trocar de plano, trocar o cartão e
 * cancelar. Todas exigem login; a sessão confere o CSRF sozinha
 * (SessionService → assertCsrf) em todo pedido que escreve.
 *
 * ⚠️ /assinar, /cartao e /trocar-plano podem carregar número de cartão e CPF.
 * Nada aqui registra corpo de requisição, e nada deve passar a registrar — ver
 * asaas.api.ts.
 */
@Controller('billing')
export class CheckoutController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly assinatura: MinhaAssinaturaService,
    private readonly sessions: SessionService,
    private readonly lock: BillingLockService,
  ) {}

  /**
   * Toda rota que pode receber um cartão divide o MESMO teto: 6 tentativas por
   * hora por conta, 15 por endereço. Um robô testando cartão roubado não ganha
   * fôlego novo trocando de /assinar para /cartao.
   */
  private tetoDeCartao(userId: string, origem: string) {
    enforceRateLimit(
      [
        [`checkout:conta:${userId}`, CHECKOUT_RATE_RULES.porConta],
        [`checkout:ip:${origem}`, CHECKOUT_RATE_RULES.porIp],
      ],
      'Muitas tentativas de pagamento em pouco tempo. Aguarde um pouco e tente de novo.',
    )
  }

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
    this.tetoDeCartao(userId, origem)
    // O IP vai ao Asaas porque ele exige o do CLIENTE na cobrança por cartão
    // (antifraude). Não é gravado aqui.
    return this.lock.comUsuario(userId, () => this.checkout.assinar(userId, body, origem))
  }

  /** GET /api/billing/assinatura — o que a tela "Minha assinatura" mostra. */
  @Get('assinatura')
  async ver(@Req() req: RequisicaoComAuth) {
    const userId = await this.sessions.requireUser(req, 'Entre na sua conta para ver sua assinatura.')
    return this.assinatura.resumo(userId)
  }

  /** POST /api/billing/cancelar — cancela; no prazo de arrependimento, devolve o valor. */
  @Post('cancelar')
  @HttpCode(200)
  async cancelar(@Req() req: RequisicaoComAuth) {
    const userId = await this.sessions.requireUser(req, 'Entre na sua conta para cancelar.')
    return this.lock.comUsuario(userId, () => this.assinatura.cancelar(userId))
  }

  /** POST /api/billing/trocar-plano — sobe na hora, desce no fim do mês pago, Free cancela. */
  @Post('trocar-plano')
  @HttpCode(200)
  async trocarPlano(
    @Body() body: unknown,
    @Req() req: RequisicaoComAuth,
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
  ) {
    const userId = await this.sessions.requireUser(req, 'Entre na sua conta para trocar de plano.')
    const origem = clientIp(ip, xff)
    // Só conta como tentativa de cartão quando HÁ cartão no pedido.
    if (body && typeof body === 'object' && 'cartao' in body) this.tetoDeCartao(userId, origem)
    return this.lock.comUsuario(userId, () => this.assinatura.trocarPlano(userId, body, origem))
  }

  /** POST /api/billing/cartao — troca o cartão da assinatura. */
  @Post('cartao')
  @HttpCode(200)
  async trocarCartao(
    @Body() body: unknown,
    @Req() req: RequisicaoComAuth,
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
  ) {
    const userId = await this.sessions.requireUser(req, 'Entre na sua conta para trocar o cartão.')
    const origem = clientIp(ip, xff)
    this.tetoDeCartao(userId, origem)
    return this.lock.comUsuario(userId, () => this.assinatura.trocarCartao(userId, body, origem))
  }
}
