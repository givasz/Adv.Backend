import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Ip,
  Post,
  UnauthorizedException,
} from '@nestjs/common'
import { AuthService } from './auth.service'
import { SessionService } from './session.service'
import { AUTH_RATE_RULES, enforceRateLimit } from '../security/rate-limit'
import { clientIp } from '../security/net'
import { fingerprint, logSecurityEvent } from '../security/audit-log'

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  // POST /api/auth/signup  → { email, password, name? }
  @Post('signup')
  async signup(
    @Body() body: { email?: string; password?: string; name?: string },
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    // Teto por IP: o cadastro devolve "já existe" para e-mail conhecido (não há
    // confirmação por e-mail ainda), então este limite é o que impede transformar
    // a rota numa consulta em massa de quem tem conta.
    const endereco = clientIp(ip, xff)
    enforceRateLimit([[`signup:${endereco}`, AUTH_RATE_RULES.signupPerIp]])
    const subject = fingerprint(typeof body?.email === 'string' ? body.email : undefined)
    try {
      const sessao = await this.auth.signup(body?.email, body?.password, body?.name)
      logSecurityEvent({
        event: 'signup_ok',
        ip: endereco,
        subject,
        userId: sessao.user.id,
        result: 'ok',
        userAgent,
      })
      return sessao
    } catch (err) {
      logSecurityEvent({ event: 'signup_fail', ip: endereco, subject, result: 'negado', userAgent })
      throw err
    }
  }

  // POST /api/auth/login  → { email, password }
  @Post('login')
  async login(
    @Body() body: { email?: string; password?: string },
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    // Duas chaves: por IP (varredura de muitas contas) e por e-mail (dicionário
    // contra UMA conta, que trocar de IP não resolve).
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase().slice(0, 200) : ''
    const endereco = clientIp(ip, xff)
    const subject = fingerprint(email)
    enforceRateLimit(
      [
        [`login:ip:${endereco}`, AUTH_RATE_RULES.loginPerIp],
        [`login:email:${email}`, AUTH_RATE_RULES.loginPerEmail],
      ],
      'Muitas tentativas de entrada. Aguarde alguns minutos e tente novamente.',
    )
    try {
      const sessao = await this.auth.login(body?.email, body?.password)
      logSecurityEvent({
        event: 'login_ok',
        ip: endereco,
        subject,
        userId: sessao.user.id,
        result: 'ok',
        userAgent,
      })
      return sessao
    } catch (err) {
      logSecurityEvent({ event: 'login_fail', ip: endereco, subject, result: 'negado', userAgent })
      throw err
    }
  }

  // GET /api/auth/me  (Authorization: Bearer <token>)
  @Get('me')
  async me(@Headers('authorization') authorization?: string) {
    const userId = await this.sessions.userIdFrom(authorization)
    if (!userId) throw new UnauthorizedException('Sessão inválida.')
    return this.auth.me(userId)
  }

  /**
   * POST /api/auth/logout — encerra a sessão DESTE aparelho.
   *
   * Apaga a linha da sessão: o token para de valer na hora, mesmo que alguém
   * tenha uma cópia. Antes, sair só limpava o navegador — quem tivesse copiado o
   * token continuava entrando pelos 7 dias restantes.
   *
   * Responde 204 mesmo com token inválido ou ausente: sair é uma intenção, não um
   * pedido que possa falhar, e um erro aqui só serviria para dizer a um curioso se
   * o token que ele tem ainda vale.
   */
  @Post('logout')
  @HttpCode(204)
  async logout(@Headers('authorization') authorization?: string) {
    const userId = await this.sessions.userIdFrom(authorization)
    await this.sessions.revoke(authorization)
    if (userId) logSecurityEvent({ event: 'logout', userId, result: 'ok' })
  }

  /**
   * POST /api/auth/logout-all — encerra TODAS as sessões da conta.
   *
   * É o botão para quando o aparelho some ou a senha vazou: derruba o celular, o
   * computador do escritório e qualquer token copiado, de uma vez. Este exige
   * sessão válida — é uma ação sobre a conta, não um simples descartar de token.
   */
  @Post('logout-all')
  async logoutAll(@Headers('authorization') authorization?: string) {
    const userId = await this.sessions.requireUser(authorization)
    const encerradas = await this.sessions.revokeAll(userId)
    logSecurityEvent({ event: 'logout_all', userId, result: 'ok' })
    return { encerradas }
  }
}
