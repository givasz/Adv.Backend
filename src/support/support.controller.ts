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
  UnauthorizedException,
} from '@nestjs/common'
import { SupportService } from './support.service'
import { isAdminAuthenticated } from '../admin/admin-auth'
import { userIdFromHeader } from '../auth/user-auth'
import { logSecurityEvent } from '../security/audit-log'
import { checkRateLimit } from '../security/rate-limit'
import { clientIp } from '../security/net'

@Controller()
export class SupportController {
  constructor(private readonly support: SupportService) {}

  // O canal é EXCLUSIVO de quem tem conta: sem sessão, não há chamado. É o que
  // separa suporte de formulário público de spam — e o que permite responder.
  private requireUser(authorization?: string): string {
    const userId = userIdFromHeader(authorization)
    if (!userId) throw new UnauthorizedException('Entre na sua conta para falar com o suporte.')
    return userId
  }

  private assertAdmin(authorization?: string, adminToken?: string) {
    if (!isAdminAuthenticated(authorization, adminToken)) {
      logSecurityEvent({ event: 'access_denied', resource: 'admin:support', result: 'negado' })
      throw new ForbiddenException('Acesso de administrador inválido')
    }
  }

  // POST /api/support  { kind, subject, message, pageUrl?, userAgent? }
  @Post('support')
  create(
    @Body()
    body: { kind?: string; subject?: string; message?: string; pageUrl?: string; userAgent?: string },
    @Headers('authorization') authorization?: string,
    @Ip() ip?: string,
    @Headers('x-forwarded-for') forwardedFor?: string,
  ) {
    const userId = this.requireUser(authorization)
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
  mine(@Headers('authorization') authorization?: string) {
    return this.support.listMine(this.requireUser(authorization))
  }

  // ---- Admin ----

  // GET /api/admin/support?status=open|in_progress|resolved
  @Get('admin/support')
  list(
    @Query('status') status?: string,
    @Headers('x-admin-token') token?: string,
    @Headers('authorization') authorization?: string,
  ) {
    this.assertAdmin(authorization, token)
    return this.support.listAll(status)
  }

  // GET /api/admin/support/counts → { open, in_progress, resolved }
  @Get('admin/support/counts')
  counts(
    @Headers('x-admin-token') token?: string,
    @Headers('authorization') authorization?: string,
  ) {
    this.assertAdmin(authorization, token)
    return this.support.counts()
  }

  // POST /api/admin/support/:id/status  { status, note? }
  @Post('admin/support/:id/status')
  setStatus(
    @Param('id') id: string,
    @Body() body: { status?: string; note?: string },
    @Headers('x-admin-token') token?: string,
    @Headers('authorization') authorization?: string,
  ) {
    this.assertAdmin(authorization, token)
    return this.support.setStatus(id, body?.status, body?.note)
  }
}
