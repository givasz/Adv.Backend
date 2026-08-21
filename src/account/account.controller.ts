import { Body, Controller, Delete, Get, Headers, Ip, Post, Req } from '@nestjs/common'
import { AccountService } from './account.service'
import { SessionService } from '../auth/session.service'
import type { RequisicaoComAuth } from '../auth/session-context'
import { enforceRateLimit } from '../security/rate-limit'
import { clientIp } from '../security/net'
import { logSecurityEvent } from '../security/audit-log'

// Painel de dados da conta — os direitos do titular, exercíveis por quem é o dono
// deles e não pelo suporte. Toda rota aqui exige sessão: são dados de uma pessoa
// específica, e a resposta é sobre ela.
@Controller('account')
export class AccountController {
  constructor(
    private readonly account: AccountService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * GET /api/account/data — leva embora uma cópia de tudo (portabilidade).
   *
   * Com teto: montar o pacote lê o perfil inteiro, a trilha de auditoria e os
   * chamados. É barato uma vez por dia e caro dez vezes por minuto.
   */
  @Get('data')
  async exportData(
    @Req() req: RequisicaoComAuth,
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
  ) {
    const userId = await this.sessions.requireUser(
      req,
      'Entre na sua conta para ver seus dados.',
    )
    enforceRateLimit([
      [`account-export:${userId}`, { windowMs: 60 * 60 * 1000, max: 10 }],
      [`account-export-ip:${clientIp(ip, xff)}`, { windowMs: 60 * 60 * 1000, max: 30 }],
    ])
    logSecurityEvent({ event: 'account_export', userId, result: 'ok' })
    return this.account.exportData(userId)
  }

  /** GET /api/account/sessions — quantos aparelhos estão logados agora. */
  @Get('sessions')
  async sessionCount(@Req() req: RequisicaoComAuth) {
    const userId = await this.sessions.requireUser(req)
    return { abertas: await this.sessions.contarAtivas(userId) }
  }

  /**
   * DELETE /api/account — apaga a conta e tudo que depende dela.
   *
   * Pede a senha no corpo: é irreversível, e uma sessão esquecida num computador
   * emprestado não pode bastar para destruir o perfil de alguém. O teto por IP
   * existe para que tentar adivinhar a senha por aqui não seja alternativa ao
   * login (que já tem o dele).
   */
  @Delete()
  async remove(
    @Body() body: { password?: string },
    @Req() req: RequisicaoComAuth,
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
  ) {
    const userId = await this.sessions.requireUser(
      req,
      'Entre na sua conta para excluí-la.',
    )
    enforceRateLimit(
      [
        [`account-delete:${userId}`, { windowMs: 60 * 60 * 1000, max: 5 }],
        [`account-delete-ip:${clientIp(ip, xff)}`, { windowMs: 60 * 60 * 1000, max: 10 }],
      ],
      'Muitas tentativas. Aguarde alguns minutos.',
    )
    const r = await this.account.deleteAccount(userId, body?.password)
    // Registrado SEM o e-mail: a conta acabou de deixar de existir, e o log não é
    // lugar para guardar o que o resto do sistema apagou.
    logSecurityEvent({ event: 'account_delete', userId, result: 'ok' })
    return r
  }

  /**
   * POST /api/account/anonymize — mantido como apelido de DELETE para quem pede
   * "anonimizar". Aqui as duas coisas são a mesma: não há o que preservar sem
   * identificar a pessoa — o perfil É a identificação dela.
   */
  @Post('anonymize')
  async anonymize(
    @Body() body: { password?: string },
    @Req() req: RequisicaoComAuth,
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
  ) {
    return this.remove(body, req, ip, xff)
  }
}
