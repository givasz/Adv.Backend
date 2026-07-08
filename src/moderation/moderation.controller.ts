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

@Controller()
export class ModerationController {
  constructor(private readonly moderation: ModerationService) {}

  // Exige sessão de admin (Bearer) ou o token estático legado (x-admin-token).
  private assertAdmin(authorization?: string, adminToken?: string) {
    if (!isAdminAuthenticated(authorization, adminToken)) {
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
    // Atrás de proxy (Render/Netlify), o IP real vem no X-Forwarded-For.
    const clientIp = forwardedFor?.split(',')[0]?.trim() || ip
    return this.moderation.createReport(slug, { ...body, ip: clientIp })
  }

  // ---- Admin: login ----

  // POST /api/admin/login  { username, password } → { token, expiresAt }
  @Post('admin/login')
  login(@Body() body: { username?: string; password?: string }) {
    if (!verifyCredentials(body?.username, body?.password)) {
      throw new UnauthorizedException('Usuário ou senha inválidos')
    }
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
