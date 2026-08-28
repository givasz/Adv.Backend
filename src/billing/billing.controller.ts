import { Body, Controller, Headers, Ip, Post, Req } from '@nestjs/common'
import { BillingService, type ResultadoDoEvento } from './billing.service'
import { BILLING_RATE_RULES, enforceRateLimit } from '../security/rate-limit'
import { clientIp } from '../security/net'

/** Request com o corpo CRU preservado pelo body parser (ver main.ts). */
interface RequisicaoComCorpoCru {
  rawBody?: Buffer
}

@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /**
   * POST /api/billing/webhook — o provedor de pagamento avisa o que aconteceu.
   *
   * Rota PÚBLICA por natureza (quem chama é um servidor de fora, sem cookie e sem
   * sessão), e é isso que faz a assinatura HMAC ser a fronteira inteira. Ela é
   * conferida ANTES de o corpo virar qualquer coisa — antes até de olhar o tipo do
   * evento.
   *
   * Não passa pelo anti-CSRF: CSRF protege contra o NAVEGADOR de alguém logado ser
   * usado como arma, e aqui não há navegador nem sessão. O que protege é a
   * assinatura.
   *
   * Responde 200 a todo evento ACEITO, mesmo quando não havia o que fazer
   * (repetido, fora de ordem, sem dono). Erro num evento assim faz o provedor
   * reenviar em laço e, depois de algumas falhas seguidas, desligar o webhook —
   * e aí a cobrança silenciosamente para de refletir a realidade.
   */
  @Post('webhook')
  async webhook(
    @Body() body: unknown,
    @Req() req: RequisicaoComCorpoCru,
    @Headers(BillingService.cabecalhoDaAssinatura) assinatura?: string,
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
  ): Promise<ResultadoDoEvento> {
    // Teto antes da criptografia: conferir HMAC é barato, mas não de graça, e a
    // rota é pública. O teto é folgado — provedor legítimo em rajada de
    // retentativas não pode ser barrado junto.
    enforceRateLimit(
      [[`billing:${clientIp(ip, xff)}`, BILLING_RATE_RULES.perIp]],
      'Muitos eventos de cobrança em pouco tempo.',
    )

    this.billing.conferirAssinatura(req.rawBody, assinatura)
    // O corpo cru vai ao registro do evento: é a prova do que o provedor mandou,
    // exatamente como mandou.
    return this.billing.processar(body, req.rawBody?.toString('utf8') ?? '')
  }
}
