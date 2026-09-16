import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Ip,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common'
import { SupportService } from './support.service'
import { AdminService } from '../admin/admin.service'
import { SessionService } from '../auth/session.service'
import type { RequisicaoComAuth } from '../auth/session-context'
import { checkRateLimit } from '../security/rate-limit'
import { clientIp } from '../security/net'
import { extensaoDe, type TipoDeAnexo } from './anexos'

/**
 * O mínimo de uma resposta HTTP para servir os bytes de uma imagem. Interface
 * local pela mesma razão de profiles.controller.ts: o projeto não instala os
 * tipos do express.
 */
interface RespostaHttp {
  setHeader(nome: string, valor: string): void
  end(corpo?: Buffer): void
  statusCode: number
}

/**
 * Entrega uma imagem de chamado. Os cabeçalhos de segurança de toda resposta
 * (CSP `default-src 'none'`, `nosniff`, `no-store`) já vêm do middleware — o
 * `no-store` fica de propósito: é captura de tela de conta alheia, e não deve
 * sobrar no cache do computador do painel.
 */
function entregarImagem(res: RespostaHttp, img: { contentType: TipoDeAnexo; bytes: Buffer }) {
  res.setHeader('Content-Type', img.contentType)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Disposition', `inline; filename="imagem-do-chamado.${extensaoDe(img.contentType)}"`)
  res.end(img.bytes)
}

@Controller()
export class SupportController {
  constructor(
    private readonly support: SupportService,
    private readonly sessions: SessionService,
    private readonly admin: AdminService,
  ) {}

  // O canal é EXCLUSIVO de quem tem conta: sem sessão, não há chamado. É o que
  // separa suporte de formulário público de spam — e o que permite responder.
  private requireUser(req: RequisicaoComAuth): Promise<string> {
    return this.sessions.requireUser(req, 'Entre na sua conta para falar com o suporte.')
  }

  // POST /api/support  { kind, subject, message, anexos?: string[], pageUrl?, userAgent? }
  @Post('support')
  async create(
    @Body()
    body: {
      kind?: string
      subject?: string
      message?: string
      pageUrl?: string
      userAgent?: string
      anexos?: unknown
    },
    @Req() req: RequisicaoComAuth,
    @Ip() ip?: string,
    @Headers('x-forwarded-for') forwardedFor?: string,
  ) {
    const userId = await this.requireUser(req)
    // Teto por usuário: chamado é conversa, não fila de mensagens. Segura tanto
    // o clique nervoso quanto uma conta comprometida despejando lixo.
    const ipKey = clientIp(ip, forwardedFor)
    const ok =
      checkRateLimit(`support:${userId}`, { windowMs: 60 * 60 * 1000, max: 10 }) &&
      checkRateLimit(`support-ip:${ipKey}`, { windowMs: 60 * 60 * 1000, max: 30 })
    if (!ok) {
      throw new ForbiddenException(
        'Você abriu muitos chamados agora há pouco. Aguarde um instante e tente de novo.',
      )
    }
    return this.support.create(userId, body)
  }

  // GET /api/support/mine → histórico do próprio advogado, com a resposta do admin
  @Get('support/mine')
  async mine(@Req() req: RequisicaoComAuth) {
    return this.support.listMine(await this.requireUser(req))
  }

  // GET /api/support/mine/novas → { novas } — o ponto no menu da conta e o aviso do painel
  @Get('support/mine/novas')
  async novas(@Req() req: RequisicaoComAuth) {
    return this.support.novas(await this.requireUser(req))
  }

  // POST /api/support/mine/vistas  { ids } → as respostas que a aba mostrou
  @Post('support/mine/vistas')
  async vistas(@Body() body: { ids?: unknown }, @Req() req: RequisicaoComAuth) {
    return this.support.marcarVistas(await this.requireUser(req), body?.ids)
  }

  // GET /api/support/:id/anexos/:anexoId → a imagem, só para o autor do chamado
  @Get('support/:id/anexos/:anexoId')
  async anexo(
    @Param('id') id: string,
    @Param('anexoId') anexoId: string,
    @Req() req: RequisicaoComAuth,
    @Res() res: RespostaHttp,
  ) {
    const userId = await this.requireUser(req)
    // Folgado para a aba de respostas cheia de miniaturas; apertado para quem
    // tenta adivinhar identificadores.
    if (!checkRateLimit(`support-anexo:${userId}`, { windowMs: 60_000, max: 120 })) {
      res.statusCode = 429
      res.setHeader('Retry-After', '60')
      return res.end()
    }
    entregarImagem(res, await this.support.anexoDoAutor(userId, id, anexoId))
  }

  // ---- Admin ----
  //
  // Ler chamado é `suporte:ler` (todo papel tem, inclusive o de só leitura);
  // mudar a situação e responder é `suporte:responder` — e essa, sim, é uma
  // decisão que chega ao advogado, então pede motivo e vai para o histórico.

  // GET /api/admin/support?status=open|in_progress|resolved&limite=&offset=
  @Get('admin/support')
  async list(
    @Req() req: RequisicaoComAuth,
    @Query('status') status?: string,
    @Query('limite') limite?: string,
    @Query('offset') offset?: string,
    @Headers('x-admin-token') token?: string,
  ) {
    await this.admin.exigir(req, 'suporte:ler', token)
    return this.support.listAll(status, limite, offset)
  }

  // GET /api/admin/support/counts → { open, in_progress, resolved }
  @Get('admin/support/counts')
  async counts(@Req() req: RequisicaoComAuth, @Headers('x-admin-token') token?: string) {
    await this.admin.exigir(req, 'suporte:ler', token)
    return this.support.counts()
  }

  // GET /api/admin/support/:id/anexos/:anexoId → a imagem, para quem lê a fila
  @Get('admin/support/:id/anexos/:anexoId')
  async anexoNoPainel(
    @Param('id') id: string,
    @Param('anexoId') anexoId: string,
    @Req() req: RequisicaoComAuth,
    @Res() res: RespostaHttp,
    @Headers('x-admin-token') token?: string,
  ) {
    await this.admin.exigir(req, 'suporte:ler', token)
    entregarImagem(res, await this.support.anexoParaPainel(id, anexoId))
  }

  /**
   * POST /api/admin/support/:id/status  { status, note? }
   *
   * A nota é o que o advogado lê em /suporte — por isso ela vale como motivo.
   * Fechar um chamado sem uma linha de resposta é fechá-lo na cara de quem
   * escreveu, e o histórico ficaria com "resolvido" e nada mais.
   */
  @Post('admin/support/:id/status')
  async setStatus(
    @Param('id') id: string,
    @Body() body: { status?: string; note?: string },
    @Req() req?: RequisicaoComAuth,
    @Headers('x-admin-token') token?: string,
    @Ip() ip?: string,
    @Headers('x-forwarded-for') forwardedFor?: string,
  ) {
    const quem = await this.admin.exigir(req, 'suporte:responder', token)
    const motivo = this.admin.exigirMotivo(body?.note, 'esta resposta')
    const antes = await this.support.situacao(id)
    const resultado = await this.support.setStatus(id, body?.status, motivo)
    await this.admin.registrar(quem, {
      action: `suporte.${body?.status ?? 'status'}`,
      targetType: 'ticket',
      targetId: id,
      reason: motivo,
      before: antes,
      after: { status: resultado.status },
      ip: clientIp(ip, forwardedFor),
    })
    return resultado
  }
}
