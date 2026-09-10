import { Body, Controller, Headers, HttpCode, Ip, Param, Post, Req } from '@nestjs/common'
import { BillingService, type ResultadoDoEvento } from './billing.service'
import { conferirEntrada, lerEnvelope, traduzir, PROVEDOR } from './pagarme'
import { BILLING_RATE_RULES, enforceRateLimit } from '../security/rate-limit'
import { clientIp } from '../security/net'

/** Request com o corpo CRU preservado pelo body parser (ver main.ts). */
interface RequisicaoComCorpoCru {
  rawBody?: Buffer
}

/**
 * POST /api/billing/pagarme/:token — a porta da Pagar.me.
 *
 * Existe separada de `/api/billing/webhook` porque a fronteira é outra: aquela
 * confere HMAC do corpo cru, e a Pagar.me não assina o corpo. Aqui a tranca é o
 * segredo no caminho e/ou o Basic Auth do painel — ver `pagarme.ts`.
 *
 * Depois da porta, tudo é igual: o evento é traduzido para o vocabulário da casa
 * e entregue ao MESMO `BillingService.processar` que já resolve idempotência,
 * ordem e reconciliação. Nenhuma política de cobrança mora neste arquivo, e é
 * assim que trocar de provedor um dia continua sendo trocar um adaptador.
 */
@Controller('billing/pagarme')
export class PagarmeController {
  constructor(private readonly billing: BillingService) {}

  @Post(':token')
  // 200 explícito. O padrão do Nest para POST é 201, e provedor de pagamento que
  // não reconhece o 2xx recebido reenvia em laço e, depois de algumas falhas,
  // desliga o webhook — e aí a cobrança para de refletir a realidade em silêncio.
  @HttpCode(200)
  async webhook(
    @Param('token') token: string,
    @Body() body: unknown,
    @Req() req: RequisicaoComCorpoCru,
    @Headers('authorization') authorization?: string,
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
  ): Promise<ResultadoDoEvento> {
    // Teto antes de qualquer trabalho: a rota é pública. Folgado de propósito —
    // a Pagar.me em rajada de retentativas não pode ser barrada junto.
    enforceRateLimit(
      [[`pagarme:${clientIp(ip, xff)}`, BILLING_RATE_RULES.perIp]],
      'Muitos eventos de cobrança em pouco tempo.',
    )

    conferirEntrada(token, authorization)

    const envelope = lerEnvelope(body)
    const cru = req.rawBody?.toString('utf8') ?? ''
    const evento = traduzir(envelope)

    // Evento que não mexe em assinatura — `charge.created`, antifraude, estorno.
    // É a maioria do tráfego. Fica REGISTRADO com o payload cru e não é aplicado:
    // é esse registro que responde, meses depois, o que a Pagar.me contou naquele
    // dia — e é por ele que a forma real do payload de assinatura vai ser
    // conferida contra o que este adaptador supõe.
    if (!evento) {
      return this.billing.registrarBruto({
        id: envelope.id,
        provider: PROVEDOR,
        type: envelope.type,
        occurredAt: envelope.occurredAt,
        payload: cru,
        note: 'tipo não tratado',
      })
    }

    return this.billing.processar(evento, cru)
  }
}
