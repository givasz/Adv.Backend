// As rotas da contestação.
//
// Três públicos, e a diferença entre eles é o que decide a autenticação:
//
//   • **O advogado que consegue entrar** (aviso, ocultação, restrição) contesta
//     pelo painel, com sessão normal.
//   • **O advogado suspenso ou encerrado** não consegue entrar — e bloquear o
//     login é justamente o que tira o canal de contestar a suspensão. Ele usa
//     `/appeals/contestar`, que confere e-mail e senha e **não abre sessão**.
//   • **O painel**, que lê a fila e responde.

import { Body, Controller, Get, Headers, Ip, Param, Post, Query, Req } from '@nestjs/common'
import { AppealsService } from './appeals.service'
import { AdminService } from '../admin/admin.service'
import { SessionService } from '../auth/session.service'
import type { RequisicaoComAuth } from '../auth/session-context'
import { clientIp } from '../security/net'
import { enforceRateLimit } from '../security/rate-limit'
import { fingerprint } from '../security/audit-log'

/**
 * A porta sem sessão é um ponto de verificação de senha exposto ao público —
 * merece o mesmo teto de um login. Sem ele, seria um oráculo de senhas mais
 * silencioso que o próprio login.
 */
const CONTESTAR_RULES = {
  perIp: { windowMs: 15 * 60 * 1000, max: 8 },
  /** Dicionário contra UMA conta, que trocar de IP não resolve. */
  perConta: { windowMs: 15 * 60 * 1000, max: 8 },
  /**
   * Backstop contra varredura distribuída — e SÓ isso.
   *
   * Era 60, e nesse tamanho ele era uma alavanca: sessenta requisições de
   * qualquer estranho fechavam por quinze minutos o ÚNICO canal por onde um
   * advogado suspenso é ouvido. Um teto global que se esgota é sempre um botão
   * de desligar ao alcance de quem não deveria alcançá-lo — o mesmo defeito que
   * o login do painel tinha (ver AUTH_RATE_RULES.adminLoginGlobal). Quem faz o
   * trabalho fino aqui é o teto por conta acima.
   */
  global: { windowMs: 15 * 60 * 1000, max: 600 },
}

@Controller()
export class AppealsController {
  constructor(
    private readonly appeals: AppealsService,
    private readonly sessions: SessionService,
    private readonly admin: AdminService,
  ) {}

  // ---- O advogado ------------------------------------------------------------

  /** GET /api/appeals/mine → o que dá para contestar e o que já foi contestado. */
  @Get('appeals/mine')
  async minhas(@Req() req: RequisicaoComAuth) {
    return this.appeals.minhas(await this.sessions.requireUser(req))
  }

  // POST /api/appeals  { texto }
  @Post('appeals')
  async abrir(@Req() req: RequisicaoComAuth, @Body() body: { texto?: string }) {
    return this.appeals.abrir(await this.sessions.requireUser(req), body?.texto ?? '')
  }

  /**
   * POST /api/appeals/contestar  { email, senha, texto }
   *
   * Para quem a sanção impediu de entrar. Confere a credencial e NÃO abre
   * sessão: a pessoa é ouvida sem ganhar acesso a mais nada.
   */
  @Post('appeals/contestar')
  async contestarSemSessao(
    @Body() body: { email?: string; senha?: string; texto?: string },
    @Ip() ip?: string,
    @Headers('x-forwarded-for') forwardedFor?: string,
  ) {
    const endereco = clientIp(ip, forwardedFor)
    enforceRateLimit(
      [
        [`contestar:${endereco}`, CONTESTAR_RULES.perIp],
        // Impressão digital, nunca o e-mail: a chave entra na linha de auditoria
        // quando o limite estoura (ver security/audit-log.ts).
        [`contestar:conta:${fingerprint(body?.email) ?? 'sem-email'}`, CONTESTAR_RULES.perConta],
        ['contestar:global', CONTESTAR_RULES.global],
      ],
      'Muitas tentativas. Aguarde alguns minutos.',
    )
    return this.appeals.abrirPorCredencial(body?.email, body?.senha, body?.texto ?? '')
  }

  // ---- O painel --------------------------------------------------------------

  // GET /api/admin/appeals?status=open|all&limite=&offset=
  @Get('admin/appeals')
  async listar(
    @Req() req: RequisicaoComAuth,
    @Query('status') status?: string,
    @Query('limite') limite?: string,
    @Query('offset') offset?: string,
    @Headers('x-admin-token') token?: string,
  ) {
    await this.admin.exigir(req, 'moderacao:ler', token)
    // Acerta o rótulo do que a plataforma deixou vencer. A medida em si já caiu
    // sozinha na abertura da contestação; isto evita o histórico dizer que uma
    // contestação segue aberta quando o prazo dela passou.
    await this.appeals.encerrarVencidas()
    return this.appeals.listar(status ?? 'open', limite, offset)
  }

  // GET /api/admin/appeals/counts → { abertas, vencendo }
  @Get('admin/appeals/counts')
  async contadores(@Req() req: RequisicaoComAuth, @Headers('x-admin-token') token?: string) {
    await this.admin.exigir(req, 'moderacao:ler', token)
    return this.appeals.contadores()
  }

  /**
   * POST /api/admin/appeals/:id/decidir  { aceita, resposta }
   *
   * A resposta é o que o advogado lê — por isso vale como motivo e é obrigatória.
   * Aceitar derruba a medida inteira, inclusive a suspensão e a pausa da
   * cobrança que vieram com ela; recusar devolve o prazo que a medida tinha
   * antes de o relógio da contestação encurtá-lo.
   */
  @Post('admin/appeals/:id/decidir')
  async decidir(
    @Param('id') id: string,
    @Req() req: RequisicaoComAuth,
    @Body() body: { aceita?: boolean; resposta?: string },
    @Ip() ip?: string,
    @Headers('x-forwarded-for') forwardedFor?: string,
    @Headers('x-admin-token') token?: string,
  ) {
    const quem = await this.admin.exigir(req, 'moderacao:decidir', token)
    const motivo = this.admin.exigirMotivo(body?.resposta, 'esta resposta')
    const resultado = await this.appeals.decidir(id, !!body?.aceita, motivo, quem.id)
    await this.admin.registrar(quem, {
      action: body?.aceita ? 'contestacao.aceitar' : 'contestacao.recusar',
      targetType: 'appeal',
      targetId: id,
      reason: motivo,
      ip: clientIp(ip, forwardedFor),
    })
    return resultado
  }
}
