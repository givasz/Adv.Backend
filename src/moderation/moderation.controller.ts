import {
  Body,
  Controller,
  Get,
  HttpCode,
  Headers,
  Ip,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common'
import { ModerationService } from './moderation.service'
import {
  abrirSessaoAdmin,
  assertAdmin,
  csrfDoAdmin,
  encerrarSessaoAdmin,
  sessaoAdmin,
  verifyCredentials,
} from '../admin/admin-auth'
import type { RequisicaoComAuth } from '../auth/session-context'
import { AUTH_RATE_RULES, enforceRateLimit } from '../security/rate-limit'
import { clientIp } from '../security/net'
import { logSecurityEvent } from '../security/audit-log'

@Controller()
export class ModerationController {
  constructor(private readonly moderation: ModerationService) {}

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

  /**
   * POST /api/admin/login  { username, password } → { expiresAt, csrfToken }
   *
   * A sessão sai num cookie HttpOnly restrito a `/api/admin` — nenhum token volta
   * no corpo, e o painel não guarda credencial nenhuma. O `csrfToken` que volta
   * não autentica sozinho: sem o cookie, não serve para nada.
   */
  @Post('admin/login')
  login(
    @Req() req: RequisicaoComAuth,
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
    return abrirSessaoAdmin(req)
  }

  /**
   * GET /api/admin/me — o painel continua aberto neste navegador?
   *
   * O cookie é HttpOnly, então esta é a única forma de a tela saber se ainda há
   * sessão ao ser recarregada. Devolve também o token anti-CSRF, que o painel
   * precisa para qualquer ação que decide alguma coisa.
   */
  @Get('admin/me')
  me(@Req() req: RequisicaoComAuth) {
    const sessionId = sessaoAdmin(req)
    if (!sessionId) throw new UnauthorizedException('Sessão do painel encerrada.')
    return { csrfToken: csrfDoAdmin(sessionId) }
  }

  /**
   * POST /api/admin/logout — encerra a sessão do painel.
   *
   * 204 sempre, como o logout do advogado: sair é uma intenção, e um erro aqui só
   * diria a um curioso se o cookie que ele tem ainda vale.
   */
  @Post('admin/logout')
  @HttpCode(204)
  logout(@Req() req: RequisicaoComAuth) {
    if (sessaoAdmin(req)) logSecurityEvent({ event: 'admin_logout', result: 'ok' })
    encerrarSessaoAdmin(req)
  }

  // ---- Admin: denúncias / moderação ----

  // GET /api/admin/reports?status=open|resolved|dismissed|all
  @Get('admin/reports')
  listReports(
    @Query('status') status: 'open' | 'resolved' | 'dismissed' | 'all' = 'open',
    @Req() req?: RequisicaoComAuth,
    @Headers('x-admin-token') adminToken?: string,
  ) {
    assertAdmin(req, adminToken)
    return this.moderation.listReports(status)
  }

  // GET /api/admin/profiles/:id/moderation  → perfil completo + denúncias
  @Get('admin/profiles/:id/moderation')
  profileDetail(
    @Param('id') id: string,
    @Req() req?: RequisicaoComAuth,
    @Headers('x-admin-token') adminToken?: string,
  ) {
    assertAdmin(req, adminToken)
    return this.moderation.getProfileForModeration(id)
  }

  // POST /api/admin/profiles/:id/moderate
  //   { action: 'warn'|'partial'|'restrict'|'clear', note?, hiddenSections?, reportIds? }
  @Post('admin/profiles/:id/moderate')
  moderate(
    @Param('id') id: string,
    @Body()
    body: { action: string; note?: string; hiddenSections?: string[]; reportIds?: string[] },
    @Req() req?: RequisicaoComAuth,
    @Headers('x-admin-token') adminToken?: string,
  ) {
    assertAdmin(req, adminToken)
    return this.moderation.moderateProfile(id, body)
  }

  // POST /api/admin/reports/:id/dismiss
  @Post('admin/reports/:id/dismiss')
  dismiss(
    @Param('id') id: string,
    @Req() req?: RequisicaoComAuth,
    @Headers('x-admin-token') adminToken?: string,
  ) {
    assertAdmin(req, adminToken)
    return this.moderation.dismissReport(id)
  }
}
