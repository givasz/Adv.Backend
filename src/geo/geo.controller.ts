import { Controller, Get, Headers, Ip, NotFoundException, Param } from '@nestjs/common'
import { GeoService } from './geo.service'
import { enforceRateLimit } from '../security/rate-limit'
import { clientIp } from '../security/net'

@Controller('geo')
export class GeoController {
  constructor(private readonly geo: GeoService) {}

  /**
   * GET /api/geo/cep/:cep — o endereço de um CEP.
   *
   * SEM SESSÃO de propósito. O onboarding preenche o endereço antes de a conta
   * existir (a conta só é obrigatória nos planos pagos), e exigir login aqui
   * quebraria justamente a primeira vez de quem está criando o perfil.
   *
   * A rota é pública, então o teto por IP não é zelo: sem ele, um laço de
   * terminal usaria nosso servidor como proxy de graça para varrer o ViaCEP —
   * e o IP que levaria o bloqueio do provedor seria o nosso, deixando o campo
   * de CEP fora do ar para todo mundo. 60/min cobre alguém digitando com
   * folga; a repetição real nem chega aqui (o serviço guarda em memória).
   */
  @Get('cep/:cep')
  async cep(
    @Param('cep') cep: string,
    @Ip() ip?: string,
    @Headers('x-forwarded-for') forwardedFor?: string,
  ) {
    const chave = clientIp(ip, forwardedFor)
    enforceRateLimit(
      [
        [`cep:${chave}`, { windowMs: 60 * 1000, max: 60 }],
        [`cep-hora:${chave}`, { windowMs: 60 * 60 * 1000, max: 600 }],
      ],
      'Muitas consultas de CEP em pouco tempo. Você pode preencher o endereço à mão.',
    )
    const achado = await this.geo.cep(cep)
    // 404 e não 200-com-null: "este CEP não existe" é a resposta que o campo
    // precisa distinguir de "o provedor não respondeu", e o editor trata as
    // duas do mesmo jeito seguro — deixa a pessoa digitar.
    if (!achado) throw new NotFoundException('CEP não encontrado')
    return achado
  }
}
