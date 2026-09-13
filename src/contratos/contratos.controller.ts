import { Body, Controller, Delete, Get, Headers, Ip, Param, Post, Put, Query, Req } from '@nestjs/common'
import { ContratosService } from './contratos.service'
import { ModelosPropriosService } from './modelos-proprios.service'
import { SessionService } from '../auth/session.service'
import type { RequisicaoComAuth } from '../auth/session-context'
import { enforceRateLimit } from '../security/rate-limit'
import { clientIp } from '../security/net'

@Controller('contratos')
export class ContratosController {
  constructor(
    private readonly contratos: ContratosService,
    private readonly sessions: SessionService,
    private readonly modelos: ModelosPropriosService,
  ) {}

  private requireUser(req: RequisicaoComAuth): Promise<string> {
    return this.sessions.requireUser(req, 'Entre na sua conta para cuidar dos seus documentos.')
  }

  /** Gravar modelo é raro: um advogado ajusta três textos, não sessenta por hora. */
  private limitarModelos(userId: string) {
    enforceRateLimit(
      [[`contratos:modelos:${userId}`, { windowMs: 60 * 60 * 1000, max: 60 }]],
      'Muitas alterações de modelo em pouco tempo. Aguarde alguns minutos e tente de novo.',
    )
  }

  // ---- Modelos próprios (até 3, no Max) — só texto, nunca dado de cliente ----

  // GET /api/contratos/modelos → { modelos, limite }
  @Get('modelos')
  async listarModelos(@Req() req: RequisicaoComAuth) {
    return this.modelos.listar(await this.requireUser(req))
  }

  // POST /api/contratos/modelos  { nome, quemAssina, titulo, clausulas: [{ titulo, texto }] }
  @Post('modelos')
  async criarModelo(@Body() body: any, @Req() req: RequisicaoComAuth) {
    const userId = await this.requireUser(req)
    this.limitarModelos(userId)
    return this.modelos.criar(userId, body)
  }

  // PUT /api/contratos/modelos/:id  (mesmo corpo)
  @Put('modelos/:id')
  async atualizarModelo(@Param('id') id: string, @Body() body: any, @Req() req: RequisicaoComAuth) {
    const userId = await this.requireUser(req)
    this.limitarModelos(userId)
    return this.modelos.atualizar(userId, id, body)
  }

  // DELETE /api/contratos/modelos/:id — vale em qualquer plano
  @Delete('modelos/:id')
  async excluirModelo(@Param('id') id: string, @Req() req: RequisicaoComAuth) {
    const userId = await this.requireUser(req)
    this.limitarModelos(userId)
    return this.modelos.excluir(userId, id)
  }

  // GET /api/contratos/registros → { registros } da própria conta
  @Get('registros')
  async listar(@Req() req: RequisicaoComAuth) {
    return this.contratos.listar(await this.requireUser(req))
  }

  /**
   * POST /api/contratos/registros
   *   revisado: { etapa, modelo, modeloVersao, declaracaoVersao, codigo, hash, tamanho,
   *               declaracoes: { revisei: true, responsabilidade: true } }
   *   assinado: { etapa, origemCodigo, hash, tamanho }
   *
   * O IP vai para o registro: é a declaração de revisão, e declaração sem
   * "de onde" é o aceite que não se prova (mesmo regime de User.termsIp).
   */
  @Post('registros')
  async registrar(
    @Body() body: any,
    @Req() req: RequisicaoComAuth,
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    const userId = await this.requireUser(req)
    const endereco = clientIp(ip, xff)
    // Um escritório movimentado registra algumas dezenas de documentos num dia,
    // não sessenta numa hora. O teto segura laço de script e conta comprometida.
    enforceRateLimit(
      [
        [`contratos:registro:${userId}`, { windowMs: 60 * 60 * 1000, max: 60 }],
        [`contratos:registro-ip:${endereco}`, { windowMs: 60 * 60 * 1000, max: 120 }],
      ],
      'Muitos registros em pouco tempo. Aguarde alguns minutos e tente de novo.',
    )
    return this.contratos.registrar(userId, body, { ip: endereco, userAgent: userAgent ?? '' })
  }

  /**
   * GET /api/contratos/conferir?h=<sha256>[,<sha256>…]
   *
   * Pública: quem confere é o cliente, a outra parte, um juiz — gente sem conta.
   * O arquivo nunca sobe; chega só a impressão digital calculada no aparelho.
   */
  @Get('conferir')
  async conferir(
    @Query('h') h?: string,
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
  ) {
    enforceRateLimit(
      [[`contratos:conferir-ip:${clientIp(ip, xff)}`, { windowMs: 10 * 60 * 1000, max: 40 }]],
      'Muitas conferências seguidas. Aguarde alguns minutos e tente de novo.',
    )
    return this.contratos.conferir(String(h ?? '').split(','))
  }
}
