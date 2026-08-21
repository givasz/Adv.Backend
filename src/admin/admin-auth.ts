// Autenticação de administrador — login usuário/senha + sessão em cookie HttpOnly.
//
// Segue o mesmo desenho da sessão do advogado (ver auth/): o cookie leva um
// segredo sorteado, o servidor guarda só o hash, e sair apaga a sessão de verdade.
// Antes o painel guardava um token assinado no `sessionStorage` e o mandava como
// `Authorization: Bearer` — legível por qualquer script da página, e impossível de
// revogar antes das 8 horas de validade.
//
// Duas diferenças em relação à sessão do advogado, as duas de propósito:
//
//   • **As sessões ficam em memória**, não no banco. Não há linha `User` para o
//     admin (ele vem do .env), e são poucas sessões de poucas horas. O preço é
//     que reiniciar o processo desloga o painel — o que, num painel que decide o
//     que sai do ar, é aceitável e até saudável.
//   • **O cookie vale só em `/api/admin`.** Todas as rotas do painel moram lá, e
//     assim o cookie do admin não viaja junto de nenhuma visita a perfil público.
//
// Configuração (env):
//   ADMIN_USERNAME        usuário do painel (default: "admin")
//   ADMIN_PASSWORD        senha do painel (fallback: ADMIN_TOKEN, depois "dev-admin-123")
//   ADMIN_SESSION_SECRET  segredo p/ derivar o token anti-CSRF (fallback: ADMIN_TOKEN)
//   ADMIN_SESSION_HOURS   duração da sessão do painel (padrão 8)
//
// ⚠️ Em produção defina ADMIN_PASSWORD e ADMIN_SESSION_SECRET fortes.

import { ForbiddenException } from '@nestjs/common'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { CSRF_COOKIE } from '../auth/cookies'
import { assertCsrf, csrfTokenFor } from '../auth/csrf'
import { authDe, type RequisicaoComAuth } from '../auth/session-context'
import { credencialConfere, lerCookie, montarCookie, novaCredencial } from '../auth/user-auth'
import { logSecurityEvent } from '../security/audit-log'
import { IS_PROD, requireSecret } from '../security/config'

/** Nome base do cookie da sessão do painel. */
export const ADMIN_COOKIE = 'advocme_admin'
/** Nome base do cookie do token anti-CSRF do painel. */
export const ADMIN_CSRF_COOKIE = `${CSRF_COOKIE}_admin`
/** Onde os dois valem. Todas as rotas do painel estão sob este caminho. */
export const ADMIN_COOKIE_PATH = '/api/admin'

function ttlMs(): number {
  const n = Number(process.env.ADMIN_SESSION_HOURS)
  const horas = Number.isFinite(n) && n > 0 ? Math.min(n, 24) : 8
  return horas * 60 * 60 * 1000
}

function adminUsername(): string {
  return process.env.ADMIN_USERNAME || 'admin'
}

/** Identificação do admin para registrar o "responsável" pela conferência de OAB. */
export function adminLabel(): string {
  return adminUsername()
}
function adminPassword(): string {
  // Em produção não existe senha padrão: sem ADMIN_PASSWORD, nenhuma senha entra
  // (requireSecret lança) — o painel fica trancado em vez de aberto com "dev-admin-123".
  return requireSecret([process.env.ADMIN_PASSWORD, process.env.ADMIN_TOKEN], 'dev-admin-123')
}

/** Comparação de strings resistente a timing attacks. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Valida usuário/senha do painel. As duas comparações rodam SEMPRE (nada de `&&`
 * curto-circuitando a segunda): assim o tempo de resposta não diz se o usuário
 * existe. Falha fechada se o segredo não estiver configurado.
 */
export function verifyCredentials(username?: string, password?: string): boolean {
  try {
    const userOk = safeEqual(username ?? '', adminUsername())
    const passOk = safeEqual(password ?? '', adminPassword())
    return userOk && passOk
  } catch {
    return false
  }
}

// ---- Sessões do painel (em memória) ----------------------------------------

interface SessaoAdmin {
  tokenHash: string
  expiresAt: number
}

const sessoes = new Map<string, SessaoAdmin>()

/** Tira do mapa o que já venceu. Roda no login — é quando sobra tempo. */
function limparVencidas(): void {
  const agora = Date.now()
  for (const [id, s] of sessoes) if (s.expiresAt <= agora) sessoes.delete(id)
}

export interface SessaoAdminAberta {
  expiresAt: number
  csrfToken: string
}

/** Abre a sessão do painel e grava os cookies na resposta. */
export function abrirSessaoAdmin(req: RequisicaoComAuth): SessaoAdminAberta {
  limparVencidas()
  const auth = authDe(req)
  const id = randomBytes(16).toString('hex')
  const { secret, hash } = novaCredencial()
  const expiresAt = Date.now() + ttlMs()
  sessoes.set(id, { tokenHash: hash, expiresAt })

  const csrfToken = csrfTokenFor(id)
  const comum = { maxAgeMs: ttlMs(), path: ADMIN_COOKIE_PATH }
  auth.setCookie(ADMIN_COOKIE, montarCookie(id, secret), { httpOnly: true, ...comum })
  auth.setCookie(ADMIN_CSRF_COOKIE, csrfToken, { httpOnly: false, ...comum })
  return { expiresAt, csrfToken }
}

/** Id da sessão do painel nesta requisição, ou null. Falha fechada. */
export function sessaoAdmin(req?: RequisicaoComAuth): string | null {
  const auth = authDe(req)
  const valor = lerCookie(auth.cookie(ADMIN_COOKIE))
  if (!valor) return null
  const sessao = sessoes.get(valor.sessionId)
  if (!sessao) return null
  if (sessao.expiresAt <= Date.now()) {
    sessoes.delete(valor.sessionId)
    return null
  }
  if (!credencialConfere(valor.secret, sessao.tokenHash)) return null
  return valor.sessionId
}

/** Encerra a sessão do painel e apaga os cookies. Nunca lança. */
export function encerrarSessaoAdmin(req?: RequisicaoComAuth): void {
  const auth = authDe(req)
  const valor = lerCookie(auth.cookie(ADMIN_COOKIE))
  if (valor) {
    const sessao = sessoes.get(valor.sessionId)
    // Só encerra se a credencial confere: quem adivinhasse um id não derruba a
    // sessão alheia de graça.
    if (sessao && credencialConfere(valor.secret, sessao.tokenHash)) {
      sessoes.delete(valor.sessionId)
    }
  }
  auth.clearCookie(ADMIN_COOKIE, { httpOnly: true, path: ADMIN_COOKIE_PATH })
  auth.clearCookie(ADMIN_CSRF_COOKIE, { httpOnly: false, path: ADMIN_COOKIE_PATH })
}

/** Token anti-CSRF de uma sessão do painel. */
export function csrfDoAdmin(sessionId: string): string {
  return csrfTokenFor(sessionId)
}

/** Token estático legado (`x-admin-token = ADMIN_TOKEN`), para script e curl. */
function tokenEstaticoConfere(adminToken?: string): boolean {
  const staticToken = process.env.ADMIN_TOKEN
  if (!staticToken || !adminToken) return false
  // É um bearer sem expiração: em produção só vale se for longo o bastante para
  // não ser adivinhado (o boot já recusa valores fracos).
  if (IS_PROD && staticToken.length < 24) return false
  return safeEqual(adminToken, staticToken)
}

/**
 * A porta do painel. Deixa passar quem é admin e recusa o resto — sempre com
 * registro, porque cada tentativa contra o painel importa.
 *
 * Dois caminhos, e a diferença entre eles é o que decide o CSRF:
 *
 *   • **Cookie de sessão** — o navegador o manda sozinho, então toda escrita
 *     precisa provar que partiu do painel (token no cabeçalho + Origin conhecida).
 *   • **Token estático legado** — é escrito à mão por quem chama (script, curl);
 *     nenhum site consegue forjá-lo a partir do navegador de outra pessoa, então
 *     não há CSRF a proteger aqui.
 *
 * Vive aqui, e não repetido em cada controller, para que uma rota nova do painel
 * não possa esquecer metade da verificação.
 */
export function assertAdmin(
  req?: RequisicaoComAuth,
  adminToken?: string,
  resource = 'admin',
): void {
  const sessionId = sessaoAdmin(req)
  if (sessionId) {
    const auth = authDe(req)
    assertCsrf({ method: auth.method, origin: auth.origin, csrfHeader: auth.csrfHeader }, sessionId)
    return
  }
  if (tokenEstaticoConfere(adminToken)) return
  logSecurityEvent({ event: 'access_denied', resource, result: 'negado' })
  throw new ForbiddenException('Acesso de administrador inválido')
}
