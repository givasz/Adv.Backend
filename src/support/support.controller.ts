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
} from '@nestjs/common'
import { SupportService } from './support.service'
import { assertAdmin } from '../admin/admin-auth'
import { SessionService } from '../auth/session.service'
import type { RequisicaoComAuth } from '../auth/session-context'
import { checkRateLimit } from '../security/rate-limit'
import { clientIp } from '../security/net'

@Controller()
export class SupportController {
  constructor(
    private readonly support: SupportService,
    private readonly sessions: SessionService,
  ) {}

  // O canal é EXCLUSIVO de quem tem conta: sem sessão, não há chamado. É o que
  // separa suporte de formulário público de spam — e o que permite responder.
  private requireUser(req: RequisicaoComAuth): Promise<string> {
    return this.sessions.requireUser(req, 'Entre na sua conta para falar com o suporte.')
  }

  // POST /api/support  { kind, subject, message, pageUrl?, userAgent? }
  @Post('support')
  async create(
    @Body()
    body: { kind?: string; subject?: string; message?: string; pageUrl?: string; userAgent?: string },
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

  // ---- Admin ----

  // GET /api/admin/support?status=open|in_progress|resolved
  @Get('admin/support')
  list(
    @Req() req: RequisicaoComAuth,
    @Query('status') status?: string,
    @Headers('x-admin-token') token?: string,
  ) {
    assertAdmin(req, token, 'admin:support')
    return this.support.listAll(status)
  }

  // GET /api/admin/support/counts → { open, in_progress, resolved }
  @Get('admin/support/counts')
  counts(@Req() req: RequisicaoComAuth, @Headers('x-admin-token') token?: string) {
    assertAdmin(req, token, 'admin:support')
    return this.support.counts()
  }

  // POST /api/admin/support/:id/status  { status, note? }
  @Post('admin/support/:id/status')
  setStatus(
    @Param('id') id: string,
    @Body() body: { status?: string; note?: string },
    @Req() req?: RequisicaoComAuth,
    @Headers('x-admin-token') token?: string,
  ) {
    assertAdmin(req, token, 'admin:support')
    return this.support.setStatus(id, body?.status, body?.note)
  }
}
