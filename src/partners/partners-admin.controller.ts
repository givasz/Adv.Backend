// Programa Advocme Parceiros — o lado do console.
//
// Mesma porta de todo o painel (AdminService.exigir): permissão nomeada, CSRF na
// sessão, segundo fator configurado para decidir e motivo escrito em toda
// escrita, com AdminAction. O token estático legado entra como `readonly`, então
// lê e nunca decide. `support` não abre nada daqui: é dado comercial do programa.

import { Body, Controller, Get, Headers, Ip, NotFoundException, Param, Post, Query, Req } from '@nestjs/common'
import { AdminService } from '../admin/admin.service'
import type { RequisicaoComAuth } from '../auth/session-context'
import { clientIp } from '../security/net'
import { PartnersService } from './partners.service'

/** Ids internos são cuid; qualquer outra coisa nem chega ao banco. */
function idValido(id: string): string {
  if (!/^[a-z0-9]{8,40}$/i.test(id ?? '')) throw new NotFoundException('Não encontrado.')
  return id
}

@Controller('admin')
export class PartnersAdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly partners: PartnersService,
  ) {}

  /** GET /api/admin/partners?status=&q=&cursor=&limite= — por cursor, nunca a tabela inteira. */
  @Get('partners')
  async listar(
    @Req() req: RequisicaoComAuth,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('cursor') cursor?: string,
    @Query('limite') limite?: string,
    @Headers('x-admin-token') token?: string,
  ) {
    await this.admin.exigir(req, 'parceiros:ler', token)
    return this.partners.listarParaConsole({
      status,
      q,
      cursor: cursor && /^[a-z0-9]{8,40}$/i.test(cursor) ? cursor : undefined,
      limite,
    })
  }

  /**
   * GET /api/admin/partners/invites?cursor= — convites por e-mail ainda sem conta.
   * Declarada ANTES de `partners/:id`: senão "invites" seria lido como um id.
   */
  @Get('partners/invites')
  async convitesPorEmail(
    @Req() req: RequisicaoComAuth,
    @Query('cursor') cursor?: string,
    @Headers('x-admin-token') token?: string,
  ) {
    await this.admin.exigir(req, 'parceiros:ler', token)
    return this.partners.listarConvitesPorEmail(cursor)
  }

  /**
   * POST /api/admin/partners/invite  { email, reason }
   *
   * Com conta: vira participação convidada. Sem conta: o convite espera o
   * cadastro com o mesmo e-mail, e a pessoa recebe o e-mail para criar a conta.
   */
  @Post('partners/invite')
  async convidarPorEmail(
    @Req() req: RequisicaoComAuth,
    @Body() body: { email?: unknown; reason?: string },
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
    @Headers('x-admin-token') token?: string,
  ) {
    const quem = await this.admin.exigir(req, 'parceiros:gerir', token)
    const motivo = this.admin.exigirMotivo(body?.reason, 'este convite')
    const r = await this.partners.convidarPorEmail(body?.email)
    await this.admin.registrar(quem, {
      action: 'parceiro.convidar',
      targetType: r.resultado === 'conta' ? 'partner' : 'partner-invite',
      targetId: r.id,
      reason: motivo,
      before: null,
      // O e-mail vai mascarado: o histórico não guarda endereço inteiro de terceiro.
      after: { via: r.resultado, email: r.email },
      ip: clientIp(ip, xff),
    })
    return r
  }

  // POST /api/admin/partners/invites/:id/cancel  { reason }
  @Post('partners/invites/:id/cancel')
  async cancelarConvite(
    @Param('id') id: string,
    @Req() req: RequisicaoComAuth,
    @Body() body: { reason?: string },
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
    @Headers('x-admin-token') token?: string,
  ) {
    const quem = await this.admin.exigir(req, 'parceiros:gerir', token)
    const motivo = this.admin.exigirMotivo(body?.reason, 'cancelar este convite')
    const r = await this.partners.cancelarConvitePorEmail(idValido(id))
    await this.admin.registrar(quem, {
      action: 'parceiro.cancelar-convite',
      targetType: 'partner-invite',
      targetId: id,
      reason: motivo,
      before: r.antes,
      after: r.depois,
      ip: clientIp(ip, xff),
    })
    return { ok: true }
  }

  /** GET /api/admin/partners/:id?cursor= — a ficha: assinatura, indicações, recompensas e histórico. */
  @Get('partners/:id')
  async ficha(
    @Param('id') id: string,
    @Req() req: RequisicaoComAuth,
    @Query('cursor') cursor?: string,
    @Headers('x-admin-token') token?: string,
  ) {
    await this.admin.exigir(req, 'parceiros:ler', token)
    return this.partners.fichaParaConsole(idValido(id), { cursor })
  }

  // POST /api/admin/users/:userId/partner/invite  { reason }
  @Post('users/:userId/partner/invite')
  async convidar(
    @Param('userId') userId: string,
    @Req() req: RequisicaoComAuth,
    @Body() body: { reason?: string },
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
    @Headers('x-admin-token') token?: string,
  ) {
    const quem = await this.admin.exigir(req, 'parceiros:gerir', token)
    const motivo = this.admin.exigirMotivo(body?.reason, 'este convite')
    const criado = await this.partners.convidar(idValido(userId))
    await this.admin.registrar(quem, {
      action: 'parceiro.convidar',
      targetType: 'partner',
      targetId: criado.id,
      reason: motivo,
      before: null,
      after: { status: criado.status, userId },
      ip: clientIp(ip, xff),
    })
    return criado
  }

  // POST /api/admin/partners/:id/suspend  { reason }
  @Post('partners/:id/suspend')
  async suspender(
    @Param('id') id: string,
    @Req() req: RequisicaoComAuth,
    @Body() body: { reason?: string },
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
    @Headers('x-admin-token') token?: string,
  ) {
    const quem = await this.admin.exigir(req, 'parceiros:gerir', token)
    const motivo = this.admin.exigirMotivo(body?.reason, 'suspender esta participação')
    const r = await this.partners.suspender(idValido(id), motivo)
    await this.admin.registrar(quem, {
      action: 'parceiro.suspender',
      targetType: 'partner',
      targetId: id,
      reason: motivo,
      before: r.antes,
      after: r.depois,
      ip: clientIp(ip, xff),
    })
    return r.depois
  }

  // POST /api/admin/partners/:id/reactivate  { reason }
  @Post('partners/:id/reactivate')
  async reativar(
    @Param('id') id: string,
    @Req() req: RequisicaoComAuth,
    @Body() body: { reason?: string },
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
    @Headers('x-admin-token') token?: string,
  ) {
    const quem = await this.admin.exigir(req, 'parceiros:gerir', token)
    const motivo = this.admin.exigirMotivo(body?.reason, 'reativar esta participação')
    const r = await this.partners.reativar(idValido(id))
    await this.admin.registrar(quem, {
      action: 'parceiro.reativar',
      targetType: 'partner',
      targetId: id,
      reason: motivo,
      before: r.antes,
      after: r.depois,
      ip: clientIp(ip, xff),
    })
    return r.depois
  }

  // POST /api/admin/partners/:id/end  { reason }
  @Post('partners/:id/end')
  async encerrar(
    @Param('id') id: string,
    @Req() req: RequisicaoComAuth,
    @Body() body: { reason?: string },
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
    @Headers('x-admin-token') token?: string,
  ) {
    const quem = await this.admin.exigir(req, 'parceiros:gerir', token)
    const motivo = this.admin.exigirMotivo(body?.reason, 'encerrar esta participação')
    const r = await this.partners.encerrar(idValido(id), motivo)
    await this.admin.registrar(quem, {
      action: 'parceiro.encerrar',
      targetType: 'partner',
      targetId: id,
      reason: motivo,
      before: r.antes,
      after: r.depois,
      ip: clientIp(ip, xff),
    })
    return r.depois
  }

  // POST /api/admin/partners/:id/adjust  { days, reason }
  @Post('partners/:id/adjust')
  async ajustar(
    @Param('id') id: string,
    @Req() req: RequisicaoComAuth,
    @Body() body: { days?: unknown; reason?: string },
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
    @Headers('x-admin-token') token?: string,
  ) {
    const quem = await this.admin.exigir(req, 'parceiros:gerir', token)
    const motivo = this.admin.exigirMotivo(body?.reason, 'este ajuste')
    const r = await this.partners.ajustar(idValido(id), body?.days, motivo)
    await this.admin.registrar(quem, {
      action: 'parceiro.ajustar-beneficio',
      targetType: 'partner',
      targetId: id,
      reason: motivo,
      before: r.antes,
      after: r.depois,
      ip: clientIp(ip, xff),
    })
    return r.depois
  }

  // POST /api/admin/referrals/:id/reassign  { partnerId, reason }
  @Post('referrals/:id/reassign')
  async reatribuir(
    @Param('id') id: string,
    @Req() req: RequisicaoComAuth,
    @Body() body: { partnerId?: unknown; reason?: string },
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
    @Headers('x-admin-token') token?: string,
  ) {
    const quem = await this.admin.exigir(req, 'parceiros:gerir', token)
    const motivo = this.admin.exigirMotivo(body?.reason, 'esta correção')
    const r = await this.partners.reatribuir(idValido(id), body?.partnerId)
    await this.admin.registrar(quem, {
      action: 'referral.corrigir',
      targetType: 'referral',
      targetId: id,
      reason: motivo,
      before: r.antes,
      after: r.depois,
      ip: clientIp(ip, xff),
    })
    return r.depois
  }

  // POST /api/admin/partner-rewards/:id/revoke  { reason }
  @Post('partner-rewards/:id/revoke')
  async revogar(
    @Param('id') id: string,
    @Req() req: RequisicaoComAuth,
    @Body() body: { reason?: string },
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
    @Headers('x-admin-token') token?: string,
  ) {
    const quem = await this.admin.exigir(req, 'parceiros:gerir', token)
    const motivo = this.admin.exigirMotivo(body?.reason, 'revogar esta recompensa')
    const resultado = await this.partners.revogarRecompensa(idValido(id), `console: ${motivo}`)
    await this.admin.registrar(quem, {
      action: 'reward.revogar',
      targetType: 'reward',
      targetId: id,
      reason: motivo,
      after: { resultado },
      ip: clientIp(ip, xff),
    })
    return { resultado }
  }
}
