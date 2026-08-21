// O contexto de autenticação de UMA requisição.
//
// Um middleware barato monta este objeto em toda chamada: ele só lê cabeçalhos —
// nada de banco. Quem realmente valida a sessão é o SessionService, e só quando a
// rota pede o usuário. Essa preguiça é de propósito: metade do tráfego da API são
// perfis públicos, e o navegador manda o cookie neles também. Validar por reflexo
// seria uma consulta ao banco por visita de página pública, na VPS, à toa.
//
// O contexto também é quem sabe escrever cookies na resposta — é por ele que a
// renovação deslizante devolve o cookie com o prazo esticado.

import {
  cookieAttrs,
  expiredCookie,
  parseCookies,
  serializeCookie,
  type CookieAttrs,
} from './cookies'
import { CSRF_HEADER, origemDoPedido } from './csrf'

const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true'

/** O que este código usa de um `req`/`res` do Express. */
interface Requisicao {
  method?: string
  headers: Record<string, string | string[] | undefined>
  auth?: AuthContext
}

/**
 * O que uma rota precisa entregar ao SessionService: a requisição, com o
 * contexto que o middleware pendurou nela.
 *
 * O tipo existe para que passar a coisa ERRADA não compile. Enquanto o parâmetro
 * era `unknown`, um `requireUser(authorization)` esquecido de uma refatoração
 * passava pelo compilador e simplesmente nunca autenticava ninguém — uma rota
 * que responde 401 para todo mundo, em silêncio.
 */
export interface RequisicaoComAuth {
  auth?: AuthContext
}
interface Resposta {
  getHeader(nome: string): number | string | string[] | undefined
  setHeader(nome: string, valor: string | string[]): void
}

/** Onde um cookie vale e por quanto tempo. */
export interface OpcoesCookie {
  httpOnly: boolean
  /** Ausente = cookie de sessão do navegador (morre ao fechar). */
  maxAgeMs?: number
  /** Padrão `/`. O painel admin restringe o dele a `/api/admin`. */
  path?: string
}

export interface AuthContext {
  /**
   * Valor de um cookie desta requisição, pelo nome base (o prefixo `__Host-` é
   * resolvido aqui dentro). A sessão do advogado e a do painel admin são cookies
   * diferentes, com caminhos diferentes — daí ser uma função e não um campo.
   */
  cookie(base: string): string | undefined
  method: string
  origin?: string
  csrfHeader?: string
  /** Grava um cookie na resposta. */
  setCookie(base: string, valor: string, opts: OpcoesCookie): void
  /** Apaga um cookie (com os mesmos atributos com que foi gravado). */
  clearCookie(base: string, opts: OpcoesCookie): void
  /**
   * Memória da validação já feita nesta requisição. Duas rotas que perguntam
   * "quem é?" duas vezes fazem UMA leitura de sessão.
   */
  resolvida?: Promise<unknown>
}

function primeiro(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}

function anexarSetCookie(res: Resposta, valor: string): void {
  const atual = res.getHeader('Set-Cookie')
  const lista = Array.isArray(atual) ? atual : atual !== undefined ? [String(atual)] : []
  res.setHeader('Set-Cookie', [...lista, valor])
}

/**
 * Host da API como o navegador o vê. Só aceita `x-forwarded-host` quando há um
 * proxy declarado: sem isso, o cliente escolheria o próprio host e, com ele, o
 * `SameSite` do cookie (ver cookies.ts).
 */
function hostDaApi(req: Requisicao): string | undefined {
  if (TRUST_PROXY) {
    const encaminhado = primeiro(req.headers['x-forwarded-host'])?.split(',')[0]?.trim()
    if (encaminhado) return encaminhado
  }
  return primeiro(req.headers.host)
}

/** Middleware: monta `req.auth`. Registrado em main.ts, antes das rotas. */
export function sessionContext(req: Requisicao, res: Resposta, next: () => void): void {
  const origin = origemDoPedido(req)
  const host = hostDaApi(req)
  const proto = TRUST_PROXY ? primeiro(req.headers['x-forwarded-proto']) : undefined

  const atributos = (opts: OpcoesCookie): CookieAttrs =>
    cookieAttrs({ origin, host, proto, ...opts })

  // Uma leitura só do cabeçalho `Cookie`, por requisição.
  const cookies = parseCookies(primeiro(req.headers.cookie))

  req.auth = {
    cookie: (base) => cookies[`__Host-${base}`] ?? cookies[base],
    method: (req.method ?? 'GET').toUpperCase(),
    origin,
    csrfHeader: primeiro(req.headers[CSRF_HEADER]),
    setCookie(base, valor, opts) {
      anexarSetCookie(res, serializeCookie(base, valor, atributos(opts)))
    },
    clearCookie(base, opts) {
      anexarSetCookie(res, expiredCookie(base, atributos({ ...opts, maxAgeMs: 0 })))
    },
  }
  next()
}

/**
 * O contexto de uma requisição. Se o middleware não rodou (teste isolado,
 * chamada interna), devolve um contexto vazio que não autentica ninguém — falha
 * fechada, como o resto da autenticação.
 */
export function authDe(req?: RequisicaoComAuth): AuthContext {
  return (
    req?.auth ?? {
      cookie: () => undefined,
      method: 'GET',
      setCookie: () => undefined,
      clearCookie: () => undefined,
    }
  )
}
