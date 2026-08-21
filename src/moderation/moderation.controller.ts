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
import { ModerationService } from './moderation.service'
import { isAdminAuthenticated, issueSession, verifyCredentials } from '../admin/admin-auth'
import { AUTH_RATE_RULES, enforceRateLimit } from '../security/rate-limit'
import { clientIp } from '../security/net'
import { logSecurityEvent } from '../security/audit-log'

@Controller()
export class ModerationController {
  constructor(private readonly moderation: ModerationService) {}

  // Exige sessão de admin (Bearer) ou o token estático legado (x-admin-token).
  private assertAdmin(authorization?: string, adminToken?: string) {
    if (!isAdminAuthenticated(authorization, adminToken)) {
      logSecurityEvent({ event: 'access_denied', resource: 'admin', result: 'negado' })
      throw new ForbiddenException('Acesso de administrador inválido')
    }
  }

  // ---- Denúncia pública ----

  // POST /api/profiles/:slug/report  { reason, details?, reporterEmail? }
  @Post('profiles/:slug/report')
  report(
    @Param('slug') slug: string,
    @Body() body: { reason: string; details?: string; reporterEmail?: string },
    @Ip() ip?: string,
    @Headers('x-forwarded-for') forwardedFor?: string,
  ) {
    // O X-Forwarded-For só entra quando TRUST_PROXY diz que há um proxy à frente:
    // cabeçalho que o cliente escreve não pode ser a chave do rate limit.
    return this.moderation.createReport(slug, { ...body, ip: clientIp(ip, forwardedFor) })
  }

  // ---- Admin: login ----

  // POST /api/admin/login  { username, password } → { token, expiresAt }
  @Post('admin/login')
  login(
    @Body() body: { username?: string; password?: string },
    @Ip() ip?: string,
    @Headers('x-forwarded-for') forwardedFor?: string,
  ) {
    // Uma senha só protege o painel inteiro: sem teto de tentativas, é só questão
    // de tempo. O limite global segura a mesma varredura vinda de muitos IPs.
    enforceRateLimit(
      [
        [`admin-login:${clientIp(ip, forwardedFor)}`, AUTH_RATE_RULES.adminLoginPerIp],
        ['admin-login:global', AUTH_RATE_RULES.adminLoginGlobal],
      ],
      'Muitas tentativas. Aguarde alguns minutos.',
    )
    const endereco = clientIp(ip, forwardedFor)
    if (!verifyCredentials(body?.username, body?.password)) {
      // O painel de moderação decide o que some do ar: cada tentativa contra ele
      // é registrada, acertando ou não.
      logSecurityEvent({ event: 'admin_login_fail', ip: endereco, result: 'negado' })
      throw new UnauthorizedException('Usuário ou senha inválidos')
    }
    logSecurityEvent({ event: 'admin_login_ok', ip: endereco, result: 'ok' })
    return issueSession()
  }

  // ---- Admin: denúncias / moderação ----

  // GET /api/admin/reports?status=open|resolved|dismissed|all
  @Get('admin/reports')
  listReports(
    @Query('status') status: 'open' | 'resolved' | 'dismissed' | 'all' = 'open',
    @Headers('authorization') authorization?: string,
    @Headers('x-admin-token') adminToken?: string,
  ) {
    this.assertAdmin(authorization, adminToken)
    return this.moderation.listReports(status)
  }

  // GET /api/admin/profiles/:id/moderation  → perfil completo + denúncias
  @Get('admin/profiles/:id/moderation')
  profileDetail(
    @Param('id') id: string,
    @Headers('authorization') authorization?: string,
    @Headers('x-admin-token') adminToken?: string,
  ) {
    this.assertAdmin(authorization, adminToken)
    return this.moderation.getProfileForModeration(id)
  }

  // POST /api/admin/profiles/:id/moderate
  //   { action: 'warn'|'partial'|'restrict'|'clear', note?, hiddenSections?, reportIds? }
  @Post('admin/profiles/:id/moderate')
  moderate(
    @Param('id') id: string,
    @Body()
    body: { action: string; note?: string; hiddenSections?: string[]; reportIds?: string[] },
    @Headers('authorization') authorization?: string,
    @Headers('x-admin-token') adminToken?: string,
  ) {
    this.assertAdmin(authorization, adminToken)
    return this.moderation.moderateProfile(id, body)
  }

  // POST /api/admin/reports/:id/dismiss
  @Post('admin/reports/:id/dismiss')
  dismiss(
    @Param('id') id: string,
    @Headers('authorization') authorization?: string,
    @Headers('x-admin-token') adminToken?: string,
  ) {
    this.assertAdmin(authorization, adminToken)
    return this.moderation.dismissReport(id)
  }
}
