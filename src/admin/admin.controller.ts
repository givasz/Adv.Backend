// Rotas do painel que tratam do PAINEL: entrar, sair, quem sou eu, quem mais
// administra, e o histórico do que foi feito.
//
// As rotas que tratam de perfis, denúncias e chamados continuam nos módulos
// delas — o que mudou é que todas passaram a pedir uma permissão nomeada
// (ver admin-roles.ts) em vez de "tem a senha do painel".

import { Body, Controller, Get, Headers, HttpCode, Ip, Param, Post, Query, Req } from '@nestjs/common'
import { AdminService } from './admin.service'
import { ROLE_DESCRICAO, ROLE_LABEL, ADMIN_ROLES } from './admin-roles'
import type { RequisicaoComAuth } from '../auth/session-context'
import { clientIp } from '../security/net'
import { AUTH_RATE_RULES, enforceRateLimit } from '../security/rate-limit'

@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  // ---- Sessão ---------------------------------------------------------------

  /**
   * POST /api/admin/login  { username, password, totp? } → { csrfToken, name, role, … }
   *
   * A sessão sai num cookie HttpOnly restrito a `/api/admin` — nenhum token volta
   * no corpo, e o painel não guarda credencial nenhuma. O `csrfToken` que volta
   * não autentica sozinho: sem o cookie, não serve para nada.
   */
  @Post('login')
  login(
    @Req() req: RequisicaoComAuth,
    @Body() body: { username?: string; password?: string; totp?: string },
    @Ip() ip?: string,
    @Headers('x-forwarded-for') forwardedFor?: string,
  ) {
    const endereco = clientIp(ip, forwardedFor)
    // Sem teto de tentativas, uma senha que protege o painel inteiro é só questão
    // de tempo. O limite global segura a mesma varredura vinda de muitos IPs.
    enforceRateLimit(
      [
        [`admin-login:${endereco}`, AUTH_RATE_RULES.adminLoginPerIp],
        ['admin-login:global', AUTH_RATE_RULES.adminLoginGlobal],
      ],
      'Muitas tentativas. Aguarde alguns minutos.',
    )
    return this.admin.entrar(req, body, endereco)
  }

  /**
   * GET /api/admin/me — o painel continua aberto neste navegador?
   *
   * O cookie é HttpOnly, então esta é a única forma de a tela saber se ainda há
   * sessão ao ser recarregada. Devolve também o token anti-CSRF e, principalmente,
   * o que este papel pode fazer: é a lista de permissões que monta as abas.
   */
  @Get('me')
  async me(@Req() req: RequisicaoComAuth) {
    return this.admin.retrato(await this.admin.exigirSessao(req))
  }

  /**
   * POST /api/admin/logout — 204 sempre, como o logout do advogado: sair é uma
   * intenção, e um erro aqui só diria a um curioso se o cookie que ele tem vale.
   */
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: RequisicaoComAuth) {
    await this.admin.sair(req)
  }

  // ---- A própria conta ------------------------------------------------------

  // POST /api/admin/me/password  { atual, nova }
  @Post('me/password')
  async trocarSenha(
    @Req() req: RequisicaoComAuth,
    @Body() body: { atual?: string; nova?: string },
    @Ip() ip?: string,
    @Headers('x-forwarded-for') forwardedFor?: string,
  ) {
    const quem = await this.admin.exigirSessao(req)
    return this.admin.trocarPropriaSenha(quem, body?.atual ?? '', body?.nova ?? '', clientIp(ip, forwardedFor))
  }

  // POST /api/admin/me/totp/start → { segredo, otpauth }
  @Post('me/totp/start')
  async totpStart(@Req() req: RequisicaoComAuth) {
    return this.admin.iniciarTotp(await this.admin.exigirSessao(req))
  }

  // POST /api/admin/me/totp/enable  { codigo }
  @Post('me/totp/enable')
  async totpEnable(
    @Req() req: RequisicaoComAuth,
    @Body() body: { codigo?: string },
    @Ip() ip?: string,
    @Headers('x-forwarded-for') forwardedFor?: string,
  ) {
    const quem = await this.admin.exigirSessao(req)
    return this.admin.ligarTotp(quem, body?.codigo ?? '', clientIp(ip, forwardedFor))
  }

  // POST /api/admin/me/totp/disable  { senha, codigo }
  @Post('me/totp/disable')
  async totpDisable(
    @Req() req: RequisicaoComAuth,
    @Body() body: { senha?: string; codigo?: string },
    @Ip() ip?: string,
    @Headers('x-forwarded-for') forwardedFor?: string,
  ) {
    const quem = await this.admin.exigirSessao(req)
    return this.admin.desligarTotp(quem, body?.senha ?? '', body?.codigo ?? '', clientIp(ip, forwardedFor))
  }

  // ---- Administradores ------------------------------------------------------

  /** GET /api/admin/admins → lista + os papéis disponíveis (para a tela montar o seletor). */
  @Get('admins')
  async listar(@Req() req: RequisicaoComAuth, @Headers('x-admin-token') token?: string) {
    await this.admin.exigir(req, 'admins:gerir', token)
    return {
      admins: await this.admin.listarAdmins(),
      papeis: ADMIN_ROLES.map((r) => ({ id: r, label: ROLE_LABEL[r], descricao: ROLE_DESCRICAO[r] })),
    }
  }

  // POST /api/admin/admins  { email, name, password, role }
  @Post('admins')
  async criar(
    @Req() req: RequisicaoComAuth,
    @Body() body: { email?: string; name?: string; password?: string; role?: string },
    @Ip() ip?: string,
    @Headers('x-forwarded-for') forwardedFor?: string,
    @Headers('x-admin-token') token?: string,
  ) {
    const quem = await this.admin.exigir(req, 'admins:gerir', token)
    return this.admin.criarAdmin(quem, body, clientIp(ip, forwardedFor))
  }

  // POST /api/admin/admins/:id  { name?, role?, active?, reason }
  @Post('admins/:id')
  async atualizar(
    @Param('id') id: string,
    @Req() req: RequisicaoComAuth,
    @Body() body: { name?: string; role?: string; active?: boolean; reason?: string },
    @Ip() ip?: string,
    @Headers('x-forwarded-for') forwardedFor?: string,
    @Headers('x-admin-token') token?: string,
  ) {
    const quem = await this.admin.exigir(req, 'admins:gerir', token)
    return this.admin.atualizarAdmin(quem, id, body, clientIp(ip, forwardedFor))
  }

  // POST /api/admin/admins/:id/revogar  { reason }
  @Post('admins/:id/revogar')
  async revogar(
    @Param('id') id: string,
    @Req() req: RequisicaoComAuth,
    @Body() body: { reason?: string },
    @Ip() ip?: string,
    @Headers('x-forwarded-for') forwardedFor?: string,
    @Headers('x-admin-token') token?: string,
  ) {
    const quem = await this.admin.exigir(req, 'admins:gerir', token)
    return this.admin.derrubarSessoes(quem, id, body?.reason, clientIp(ip, forwardedFor))
  }

  // ---- Histórico ------------------------------------------------------------

  /** GET /api/admin/actions?admin=&action=&targetType=&targetId=&limite= */
  @Get('actions')
  async acoes(
    @Req() req: RequisicaoComAuth,
    @Query('admin') admin?: string,
    @Query('action') action?: string,
    @Query('targetType') targetType?: string,
    @Query('targetId') targetId?: string,
    @Query('limite') limite?: string,
    @Headers('x-admin-token') token?: string,
  ) {
    await this.admin.exigir(req, 'auditoria:ler', token)
    return this.admin.historico({ admin, action, targetType, targetId, limite: Number(limite) })
  }
}
