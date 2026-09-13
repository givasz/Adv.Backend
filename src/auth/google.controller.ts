import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Ip,
  Post,
  Query,
  Redirect,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common'
import { AuthService } from './auth.service'
import { origemPermitida } from './csrf'
import {
  abrirSelo,
  CAMINHO_DO_COOKIE,
  configDoGoogle,
  destinoSeguro,
  GOOGLE_COOKIE,
  lerIdToken,
  novoPedido,
  PAGINA_DE_CONCLUSAO,
  selar,
  stateConfere,
  trocarCodigo,
  urlDeAutorizacao,
  VALIDADE_MS,
  type ConfigDoGoogle,
  type IdentidadeGuardada,
  type LeituraDoToken,
  type PedidoGuardado,
} from './google'
import { authDe, type RequisicaoComAuth } from './session-context'
import { PrismaService } from '../prisma/prisma.service'
import { registrarAcesso } from '../security/access-log'
import { fingerprint, logSecurityEvent } from '../security/audit-log'
import { clientIp } from '../security/net'
import { AUTH_RATE_RULES, checkRateLimit, enforceRateLimit } from '../security/rate-limit'

/**
 * Por que a pessoa voltou à tela sem entrar. Vai na URL como código curto — a
 * tela (frontend EntrarComGooglePage) é quem traduz em frase. Nunca vai detalhe
 * técnico: a URL fica no histórico do navegador.
 */
type Recusa = 'desligado' | 'muitas' | 'cancelado' | 'expirou' | 'falhou' | 'email'

/** O cookie do fluxo: HttpOnly, só nas rotas do Google, dez minutos. */
const COOKIE = { httpOnly: true, path: CAMINHO_DO_COOKIE, maxAgeMs: VALIDADE_MS }

interface Redirecionamento {
  url: string
  statusCode: number
}

function voltarComRecusa(cfg: ConfigDoGoogle, motivo: Recusa): Redirecionamento {
  return { url: `${cfg.siteUrl}${PAGINA_DE_CONCLUSAO}?erro=${motivo}`, statusCode: 302 }
}

/**
 * "Continuar com o Google" — três passos, e só o último abre sessão.
 *
 *   1. GET  entrar    → sorteia state/nonce/PKCE, sela num cookie e manda ao Google.
 *   2. GET  retorno   → o Google devolve o navegador aqui. Confere o state, troca o
 *                       código pela identidade (servidor a servidor) e sela a
 *                       identidade no MESMO cookie. Não abre sessão.
 *   3. POST concluir  → a página, já no nosso endereço, pede a sessão.
 *
 * Por que o passo 3 existe, em vez de abrir a sessão direto no retorno: o
 * retorno é uma navegação vinda do site do Google, e o cookie da sessão gravado
 * ali nasceria com os atributos de um pedido de outro site (SameSite=None, ver
 * cookies.ts). Aberto por uma chamada da própria página, ele nasce igual ao do
 * login por senha. E é no passo 3 que a conta NOVA pede o aceite dos Termos — com
 * a caixa marcada na tela e o IP de quem marcou, como no cadastro.
 */
@Controller('auth/google')
export class GoogleController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  /** GET /api/auth/google → { ativo } — a tela só mostra o botão quando sim. */
  @Get()
  status() {
    return { ativo: configDoGoogle().ativo }
  }

  /** GET /api/auth/google/entrar?lembrar=1&next=/painel — a ida ao Google. */
  @Get('entrar')
  @Redirect()
  entrar(
    @Req() req: RequisicaoComAuth,
    @Query('lembrar') lembrar?: string,
    @Query('next') next?: string,
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
  ): Redirecionamento {
    const cfg = configDoGoogle()
    if (!cfg.ativo) return voltarComRecusa(cfg, 'desligado')
    // `checkRateLimit`, e não `enforceRateLimit`: esta rota é uma navegação, e
    // um 429 em JSON seria uma tela de código no lugar de uma frase.
    if (!checkRateLimit(`google:entrar:${clientIp(ip, xff)}`, AUTH_RATE_RULES.googlePerIp)) {
      return voltarComRecusa(cfg, 'muitas')
    }
    const pedido = novoPedido()
    const guardado: PedidoGuardado = { ...pedido, lembrar: lembrar !== '0', next: destinoSeguro(next) }
    authDe(req).setCookie(GOOGLE_COOKIE, selar('pedido', guardado, VALIDADE_MS), COOKIE)
    return { url: urlDeAutorizacao(cfg, pedido), statusCode: 302 }
  }

  /** GET /api/auth/google/retorno?code=…&state=… — a volta do Google. */
  @Get('retorno')
  @Redirect()
  async retorno(
    @Req() req: RequisicaoComAuth,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') erroDoGoogle?: string,
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<Redirecionamento> {
    const cfg = configDoGoogle()
    const auth = authDe(req)
    const endereco = clientIp(ip, xff)
    const pedido = abrirSelo<PedidoGuardado>(auth.cookie(GOOGLE_COOKIE), 'pedido')

    const recusar = (motivo: Recusa): Redirecionamento => {
      // O pedido é de uso único: toda volta que não termina em identidade o apaga.
      auth.clearCookie(GOOGLE_COOKIE, COOKIE)
      // Desistir na tela do Google não é evento de segurança; o resto é.
      if (motivo !== 'cancelado') {
        logSecurityEvent({ event: 'google_fail', ip: endereco, resource: `retorno:${motivo}`, result: 'negado', userAgent })
      }
      return voltarComRecusa(cfg, motivo)
    }

    if (!cfg.ativo) return recusar('desligado')
    if (!checkRateLimit(`google:retorno:${endereco}`, AUTH_RATE_RULES.googlePerIp)) return recusar('muitas')
    if (erroDoGoogle) return recusar(erroDoGoogle === 'access_denied' ? 'cancelado' : 'falhou')
    // Sem o cookie do pedido, ou com state diferente: esta volta não é a do
    // pedido que partiu deste navegador. É exatamente o login CSRF — ou só um
    // pedido que venceu (a pessoa demorou mais de dez minutos na tela do Google).
    if (!pedido || !stateConfere(pedido.state, state)) return recusar('expirou')
    if (typeof code !== 'string' || !code || code.length > 2048) return recusar('falhou')

    let lido: LeituraDoToken
    try {
      const idToken = await trocarCodigo(cfg, code, pedido.verifier)
      lido = lerIdToken(idToken, { clientId: cfg.clientId, nonce: pedido.nonce })
    } catch {
      return recusar('falhou')
    }
    if (!lido.ok) return recusar(lido.motivo === 'email-nao-confirmado' ? 'email' : 'falhou')

    const identidade: IdentidadeGuardada = { ...lido.identidade, lembrar: pedido.lembrar, next: pedido.next }
    auth.setCookie(GOOGLE_COOKIE, selar('identidade', identidade, VALIDADE_MS), COOKIE)
    return { url: `${cfg.siteUrl}${PAGINA_DE_CONCLUSAO}`, statusCode: 302 }
  }

  /**
   * POST /api/auth/google/concluir  { aceitouTermos? }
   *
   * Responde `{ etapa: 'aceite', email, nome }` quando a conta ainda não existe e
   * a caixa dos Termos não veio — nada é criado, e o selo continua valendo para a
   * segunda chamada. Senão, `{ etapa: 'sessao', ...sessão, next, senhaDesligada }`.
   */
  @Post('concluir')
  async concluir(
    @Req() req: RequisicaoComAuth,
    @Body() body: { aceitouTermos?: boolean },
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    const endereco = clientIp(ip, xff)
    enforceRateLimit([[`google:concluir:${endereco}`, AUTH_RATE_RULES.googlePerIp]])
    const auth = authDe(req)
    // Escrita sem sessão ainda — então sem token anti-CSRF, que só nasce com ela.
    // O que sobra, e basta, é a origem: o navegador não deixa outro site escrever
    // o Origin, e a identidade selada só existe no cookie deste navegador.
    if (!origemPermitida(auth.origin)) {
      throw new ForbiddenException('Pedido bloqueado por segurança: a origem da chamada não é reconhecida.')
    }
    if (!configDoGoogle().ativo) {
      throw new ServiceUnavailableException('A entrada com o Google está desligada no momento.')
    }
    const id = abrirSelo<IdentidadeGuardada>(auth.cookie(GOOGLE_COOKIE), 'identidade')
    if (!id) {
      throw new UnauthorizedException(
        'O pedido de entrada com o Google venceu. Volte e toque em "Continuar com o Google" de novo.',
      )
    }

    const subject = fingerprint(id.email)
    try {
      const r = await this.auth.entrarComGoogle(req, id, {
        lembrar: id.lembrar === true,
        aceitouTermos: body?.aceitouTermos === true,
        ip: endereco,
      })
      if (r.etapa === 'aceite') return r

      auth.clearCookie(GOOGLE_COOKIE, COOKIE)
      const userId = r.sessao.user.id
      logSecurityEvent({
        event: r.novaConta ? 'signup_ok' : 'login_ok',
        ip: endereco,
        subject,
        userId,
        resource: 'google',
        result: 'ok',
        userAgent,
      })
      if (r.vinculou) {
        logSecurityEvent({
          event: 'google_linked',
          ip: endereco,
          subject,
          userId,
          resource: r.senhaDesligada ? 'senha-desligada' : undefined,
          result: 'ok',
          userAgent,
        })
      }
      // Registro de acesso (Marco Civil, art. 15) — entrar pelo Google é entrar.
      await registrarAcesso(this.prisma, {
        userId,
        email: r.sessao.user.email,
        action: r.novaConta ? 'signup' : 'login',
        ip: endereco,
        userAgent,
      })
      return { etapa: 'sessao' as const, ...r.sessao, next: destinoSeguro(id.next), senhaDesligada: r.senhaDesligada }
    } catch (err) {
      auth.clearCookie(GOOGLE_COOKIE, COOKIE)
      logSecurityEvent({ event: 'google_fail', ip: endereco, subject, resource: 'concluir', result: 'negado', userAgent })
      throw err
    }
  }
}
