import { Body, Controller, Get, Headers, Ip, Param, Post, Query, Req } from '@nestjs/common'
import { ModerationService } from './moderation.service'
import { AdminService } from '../admin/admin.service'
import type { RequisicaoComAuth } from '../auth/session-context'
import { clientIp } from '../security/net'

@Controller()
export class ModerationController {
  constructor(
    private readonly moderation: ModerationService,
    private readonly admin: AdminService,
  ) {}

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

  // ---- Admin: denúncias / moderação ----
  //
  // Entrar, sair e "quem sou eu" moram em admin/admin.controller.ts. Aqui ficam
  // só as rotas que decidem sobre perfis — cada uma pedindo a permissão que lhe
  // cabe: consultar a fila é `moderacao:ler`, tirar algo do ar é
  // `moderacao:decidir`, e quem responde suporte não tem a segunda.

  // GET /api/admin/reports?status=open|resolved|dismissed|all
  @Get('admin/reports')
  async listReports(
    @Query('status') status: 'open' | 'resolved' | 'dismissed' | 'all' = 'open',
    @Req() req?: RequisicaoComAuth,
    @Headers('x-admin-token') adminToken?: string,
  ) {
    await this.admin.exigir(req, 'moderacao:ler', adminToken)
    return this.moderation.listReports(status)
  }

  // GET /api/admin/profiles/:id/moderation  → perfil completo + denúncias
  @Get('admin/profiles/:id/moderation')
  async profileDetail(
    @Param('id') id: string,
    @Req() req?: RequisicaoComAuth,
    @Headers('x-admin-token') adminToken?: string,
  ) {
    await this.admin.exigir(req, 'moderacao:ler', adminToken)
    return this.moderation.getProfileForModeration(id)
  }

  /**
   * POST /api/admin/profiles/:id/moderate
   *   { action: 'warn'|'partial'|'restrict'|'clear', note?, reason?, hiddenSections?, reportIds? }
   *
   * O motivo é obrigatório, e não é burocracia: nas três ações que restringem
   * alguma coisa ele É o texto que o advogado lê no editor (`moderationNote`) —
   * uma decisão sem motivo escrito é uma decisão que a pessoa não tem como
   * contestar. Ao liberar, o aviso sai do perfil, então o motivo vai só para o
   * histórico, e por isso vem em `reason`.
   */
  @Post('admin/profiles/:id/moderate')
  async moderate(
    @Param('id') id: string,
    @Body()
    body: {
      action: string
      note?: string
      reason?: string
      hiddenSections?: string[]
      reportIds?: string[]
    },
    @Req() req?: RequisicaoComAuth,
    @Headers('x-admin-token') adminToken?: string,
    @Ip() ip?: string,
    @Headers('x-forwarded-for') forwardedFor?: string,
  ) {
    const quem = await this.admin.exigir(req, 'moderacao:decidir', adminToken)
    const motivo =
      body?.action === 'clear'
        ? this.admin.exigirMotivo(body?.reason ?? body?.note, 'liberar o perfil')
        : this.admin.exigirMotivo(body?.note, 'esta decisão')

    const antes = await this.moderation.estadoDeModeracao(id)
    const perfil = await this.moderation.moderateProfile(id, { ...body, note: body?.note ?? motivo })
    await this.admin.registrar(quem, {
      action: `moderacao.${body.action}`,
      targetType: 'profile',
      targetId: id,
      reason: motivo,
      before: antes,
      after: {
        moderationStatus: perfil.moderationStatus,
        hiddenSections: perfil.hiddenSections,
        slug: perfil.slug,
      },
      ip: clientIp(ip, forwardedFor),
    })
    return perfil
  }

  // POST /api/admin/reports/:id/dismiss  { reason }
  @Post('admin/reports/:id/dismiss')
  async dismiss(
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @Req() req?: RequisicaoComAuth,
    @Headers('x-admin-token') adminToken?: string,
    @Ip() ip?: string,
    @Headers('x-forwarded-for') forwardedFor?: string,
  ) {
    const quem = await this.admin.exigir(req, 'moderacao:decidir', adminToken)
    const motivo = this.admin.exigirMotivo(body?.reason, 'arquivar esta denúncia')
    const resultado = await this.moderation.dismissReport(id)
    await this.admin.registrar(quem, {
      action: 'moderacao.arquivar-denuncia',
      targetType: 'report',
      targetId: id,
      reason: motivo,
      ip: clientIp(ip, forwardedFor),
    })
    return resultado
  }
}
