import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Ip,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common'
import { AuthService } from './auth.service'
import { SessionService } from './session.service'
import type { RequisicaoComAuth } from './session-context'
import { AUTH_RATE_RULES, enforceRateLimit } from '../security/rate-limit'
import { clientIp } from '../security/net'
import { fingerprint, logSecurityEvent } from '../security/audit-log'

/**
 * Entrada e saída da conta.
 *
 * Nenhuma destas rotas devolve credencial no corpo. Quem entra recebe um cookie
 * HttpOnly (ver auth/cookies.ts) que o navegador guarda e reapresenta sozinho —
 * inclusive depois de fechar e reabrir a janela, quando o login pediu para ser
 * lembrado. O corpo traz só o que a interface precisa desenhar: quem é a pessoa,
 * até quando vale a sessão e o token anti-CSRF.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  // "Lembrar de mim" chega como booleano; qualquer outra coisa vira o padrão.
  // O padrão é LEMBRAR: é o comportamento que as pessoas esperam de uma
  // ferramenta de trabalho, e o oposto (deslogar ao fechar o navegador) precisa
  // ser uma escolha explícita de quem está num computador emprestado.
  private lembrar(valor: unknown): boolean {
    return typeof valor === 'boolean' ? valor : true
  }

  // POST /api/auth/signup  → { email, password, name?, remember? }
  @Post('signup')
  async signup(
    @Req() req: RequisicaoComAuth,
    @Body() body: { email?: string; password?: string; name?: string; remember?: boolean },
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
      const sessao = await this.auth.signup(
        req,
        body?.email,
        body?.password,
        body?.name,
        this.lembrar(body?.remember),
      )
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

  // POST /api/auth/login  → { email, password, remember? }
  @Post('login')
  async login(
    @Req() req: RequisicaoComAuth,
    @Body() body: { email?: string; password?: string; remember?: boolean },
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
      const sessao = await this.auth.login(
        req,
        body?.email,
        body?.password,
        this.lembrar(body?.remember),
      )
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

  /**
   * GET /api/auth/me — quem está logado neste navegador.
   *
   * É por aqui que o front descobre que continua autenticado ao abrir o site: o
   * cookie viaja sozinho, o servidor confere e devolve a pessoa. Como o cookie é
   * HttpOnly, esta chamada é a ÚNICA forma de a página saber que há sessão — e é
   * também onde a renovação deslizante acontece (dentro do SessionService).
   */
  @Get('me')
  async me(@Req() req: RequisicaoComAuth) {
    const sessao = await this.sessions.sessaoAtual(req)
    if (!sessao) throw new UnauthorizedException('Sessão inválida.')
    return {
      user: await this.auth.me(sessao.userId),
      expiresAt: sessao.expiresAt,
      csrfToken: this.sessions.csrfDe(sessao),
      remember: sessao.remember,
    }
  }

  /**
   * POST /api/auth/logout — encerra a sessão DESTE aparelho.
   *
   * Apaga a linha da sessão e manda o navegador descartar o cookie: a credencial
   * para de valer na hora, mesmo que alguém tenha uma cópia.
   *
   * Responde 204 mesmo sem sessão: sair é uma intenção, não um pedido que possa
   * falhar, e um erro aqui só serviria para dizer a um curioso se o cookie que
   * ele tem ainda vale. Pelo mesmo motivo o token anti-CSRF é dispensado — a
   * origem ainda é conferida, e forçar alguém a sair é aborrecimento, não roubo.
   */
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: RequisicaoComAuth) {
    const userId = await this.sessions.encerrar(req)
    if (userId) logSecurityEvent({ event: 'logout', userId, result: 'ok' })
  }

  /**
   * POST /api/auth/senha  { atual, nova } — troca a própria senha.
   *
   * Exige sessão E a senha atual: um cookie roubado não basta para tomar a conta.
   * Derruba as OUTRAS sessões e mantém esta — ver AuthService.trocarSenha.
   *
   * Não confundir com "esqueci minha senha", que precisa de e-mail e ainda não
   * existe. Esta rota fecha o item 6 de "Em aberto" do SEGURANCA.md, que não
   * dependia de correio nenhum e por isso pôde vir antes.
   *
   * Limite por IP e por conta porque a senha atual é conferida aqui: sem teto,
   * esta rota viraria um oráculo para adivinhar a senha a partir de uma sessão
   * sequestrada, sem passar pelo limite do login.
   */
  @Post('senha')
  async trocarSenha(
    @Body() body: { atual?: string; nova?: string },
    @Req() req: RequisicaoComAuth,
    @Ip() ip?: string,
    @Headers('x-forwarded-for') forwardedFor?: string,
  ) {
    const userId = await this.sessions.requireUser(req)
    enforceRateLimit([
      ['senha:ip:' + clientIp(ip, forwardedFor), { windowMs: 3_600_000, max: 10 }],
      ['senha:user:' + userId, { windowMs: 3_600_000, max: 10 }],
    ])
    const resultado = await this.auth.trocarSenha(req, userId, body?.atual, body?.nova)
    logSecurityEvent({ event: 'password_changed', userId, result: 'ok' })
    return resultado
  }

  /**
   * POST /api/auth/logout-all — encerra TODAS as sessões da conta.
   *
   * É o botão para quando o aparelho some ou a senha vazou: derruba o celular, o
   * computador do escritório e qualquer cookie copiado, de uma vez. Este exige
   * sessão válida — é uma ação sobre a conta, não um simples descartar de cookie.
   */
  @Post('logout-all')
  async logoutAll(@Req() req: RequisicaoComAuth) {
    const userId = await this.sessions.requireUser(req)
    const encerradas = await this.sessions.encerrarTodas(userId, req)
    logSecurityEvent({ event: 'logout_all', userId, result: 'ok' })
    return { encerradas }
  }
}
