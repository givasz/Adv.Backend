import { Body, Controller, Headers, HttpCode, Ip, Post, Req } from '@nestjs/common'
import { BillingService, type ResultadoDoEvento } from './billing.service'
import { CABECALHO_TOKEN, conferirEntrada, lerEnvelope, traduzir, PROVEDOR } from './asaas'
import { BILLING_RATE_RULES, enforceRateLimit } from '../security/rate-limit'
import { clientIp } from '../security/net'

/** Request com o corpo CRU preservado pelo body parser (ver main.ts). */
interface RequisicaoComCorpoCru {
  rawBody?: Buffer
}

/**
 * POST /api/billing/asaas — a porta do Asaas.
 *
 * Separada de `/api/billing/webhook` porque a fronteira é outra: aquela confere
 * HMAC do corpo cru, e o Asaas não assina o corpo — ele manda um token nosso no
 * cabeçalho `asaas-access-token` (ver `asaas.ts`).
 *
 * Depois da porta, tudo é igual: o evento é traduzido para o vocabulário da casa
 * e entregue ao MESMO `BillingService.processar` que já resolve idempotência,
 * ordem e reconciliação. Nenhuma política de cobrança mora neste arquivo.
 *
 * ⚠️ O ASAAS PARA A FILA DEPOIS DE 15 FALHAS SEGUIDAS e guarda os eventos por só
 * 14 dias. Uma rota que responde erro em laço não "atrasa" a cobrança: ela a
 * DESLIGA, em silêncio, e o que passar de duas semanas se perde. Por isso todo
 * evento aceito devolve 200 — inclusive o repetido, o fora de ordem e o que não
 * mexe em assinatura. Só responde erro o que não é do Asaas (sem token, token
 * errado, corpo sem id), e esses não deveriam existir.
 */
@Controller('billing/asaas')
export class AsaasController {
  constructor(private readonly billing: BillingService) {}

  @Post()
  // 200 explícito. O padrão do Nest para POST é 201, e o Asaas documenta que
  // espera 200.
  @HttpCode(200)
  async webhook(
    @Body() body: unknown,
    @Req() req: RequisicaoComCorpoCru,
    @Headers(CABECALHO_TOKEN) token?: string,
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
  ): Promise<ResultadoDoEvento> {
    // Teto antes de qualquer trabalho: a rota é pública. Folgado de propósito —
    // o Asaas em rajada de retentativas não pode ser barrado junto.
    enforceRateLimit(
      [[`asaas:${clientIp(ip, xff)}`, BILLING_RATE_RULES.perIp]],
      'Muitos eventos de cobrança em pouco tempo.',
    )

    conferirEntrada(token)

    const envelope = lerEnvelope(body)
    const cru = req.rawBody?.toString('utf8') ?? ''
    const evento = traduzir(envelope)

    // Evento que não mexe em assinatura — cobrança criada, boleto visualizado,
    // estorno. É a maioria do tráfego. Fica REGISTRADO com o payload cru e não é
    // aplicado: é esse registro que responde, meses depois, o que o Asaas contou
    // naquele dia — e é por ele que a forma real do payload vai ser conferida
    // contra o que este adaptador supõe.
    if (!evento) {
      return this.billing.registrarBruto({
        id: envelope.id,
        provider: PROVEDOR,
        type: envelope.event,
        occurredAt: envelope.occurredAt,
        payload: cru,
        note: 'tipo não tratado',
      })
    }

    return this.billing.processar(evento, cru)
  }
}
