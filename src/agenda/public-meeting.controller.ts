import { Body, Controller, Headers, Ip, Param, Post } from '@nestjs/common'
import { clientIp } from '../security/net'
import { enforceRateLimit } from '../security/rate-limit'
import { AgendaService } from './agenda.service'

@Controller()
export class PublicMeetingController {
  constructor(private readonly agenda: AgendaService) {}

  // Mesmo teto nas duas portas: por quem envia (5 em 15 min) e por página de
  // destino (60 em 1 h). A chave da página leva prefixo para um escritório e um
  // perfil de mesmo slug não dividirem o mesmo balde. O `enforceRateLimit` fica
  // no corpo de cada rota, e não num método comum: é ali que quem lê a rota (e o
  // teste de portas, em rotas.spec) procura a barreira.
  @Post('profiles/:slug/meeting-requests')
  request(@Param('slug') slug: string, @Body() body: any, @Ip() ip?: string, @Headers('x-forwarded-for') forwardedFor?: string) {
    const key = clientIp(ip, forwardedFor)
    enforceRateLimit([[`meeting:${key}`, { windowMs: 900_000, max: 5 }], [`meeting:perfil:${slug}`, { windowMs: 3_600_000, max: 60 }]])
    return this.agenda.solicitar(slug, body)
  }

  // Pedido feito na página da SOCIEDADE. Pode nascer endereçado a um advogado
  // (body.lawyerId) ou ficar na caixa do escritório para quem administra
  // encaminhar. Ver AgendaService.solicitarNoEscritorio.
  @Post('firms/:slug/meeting-requests')
  requestFirm(@Param('slug') slug: string, @Body() body: any, @Ip() ip?: string, @Headers('x-forwarded-for') forwardedFor?: string) {
    const key = clientIp(ip, forwardedFor)
    enforceRateLimit([[`meeting:${key}`, { windowMs: 900_000, max: 5 }], [`meeting:escritorio:${slug}`, { windowMs: 3_600_000, max: 60 }]])
    return this.agenda.solicitarNoEscritorio(slug, body)
  }
}
