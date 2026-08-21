// Cookies de sessão — onde o navegador guarda "quem é você".
//
// A regra que manda em tudo aqui: o identificador da sessão é HttpOnly. Nenhum
// script da página o lê, então um XSS que consiga rodar na nossa origem não sai
// com a sessão de ninguém no bolso. Era o buraco do desenho anterior, em que o
// token ficava no localStorage — legível por qualquer linha de JavaScript que
// entrasse na página, e por qualquer extensão.
//
// Sem dependência nova (nem `cookie-parser`): o que a API faz com cookie cabe em
// duas funções, e o resto do projeto segue o mesmo hábito (ver security/headers.ts,
// escrito à mão em vez de `helmet`).
//
// Configuração (env, todas opcionais):
//   AUTH_COOKIE_SAMESITE  lax | strict | none   (padrão: decidido por requisição)
//   AUTH_COOKIE_DOMAIN    ex.: ".advoc.me" para compartilhar com subdomínios
//   AUTH_COOKIE_SECURE    1 para forçar Secure fora de produção (túnel https)

import { IS_PROD } from '../security/config'

/** Nome base do cookie da sessão (HttpOnly). */
export const SESSION_COOKIE = 'advocme_session'
/** Nome base do cookie do token anti-CSRF (legível pelo JS, de propósito). */
export const CSRF_COOKIE = 'advocme_csrf'

// Prefixo `__Host-`: o navegador só aceita gravar um cookie com esse nome se ele
// vier com Secure, Path=/ e SEM Domain. Isso fecha a injeção por subdomínio — um
// http://qualquer.coisa.advoc.me comprometido não consegue plantar uma sessão no
// domínio principal (fixação de sessão). Só dá para usar quando não precisamos do
// atributo Domain; por isso o nome é escolhido em função dos atributos.
const HOST_PREFIX = '__Host-'

export type SameSite = 'lax' | 'strict' | 'none'

export interface CookieAttrs {
  httpOnly: boolean
  secure: boolean
  sameSite: SameSite
  path: string
  domain?: string
  /** Ausente = cookie de sessão do navegador (morre ao fechar). */
  maxAgeMs?: number
}

// ---- Leitura ---------------------------------------------------------------

/** Quebra o cabeçalho `Cookie` em pares. Valores inválidos são ignorados. */
export function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const parte of header.split(';')) {
    const i = parte.indexOf('=')
    if (i < 1) continue
    const nome = parte.slice(0, i).trim()
    if (!nome) continue
    const bruto = parte.slice(i + 1).trim()
    const valor = bruto.startsWith('"') && bruto.endsWith('"') ? bruto.slice(1, -1) : bruto
    try {
      out[nome] = decodeURIComponent(valor)
    } catch {
      out[nome] = valor
    }
  }
  return out
}

/**
 * Lê um cookie aceitando as duas formas do nome (com e sem `__Host-`).
 *
 * As duas existem porque o prefixo depende dos atributos, e os atributos podem
 * mudar entre deploys (por exemplo, ao passar a usar AUTH_COOKIE_DOMAIN). Sem
 * isso, uma mudança de configuração deslogaria todo mundo sem motivo.
 */
export function readCookie(header: string | undefined, base: string): string | undefined {
  const cookies = parseCookies(header)
  return cookies[`${HOST_PREFIX}${base}`] ?? cookies[base]
}

/** Nome efetivo do cookie, dados os atributos com que ele será gravado. */
export function cookieName(base: string, attrs: CookieAttrs): string {
  const podeHost = attrs.secure && !attrs.domain && attrs.path === '/'
  return podeHost ? `${HOST_PREFIX}${base}` : base
}

// ---- Escrita ---------------------------------------------------------------

/** Monta o valor de um cabeçalho `Set-Cookie`. */
export function serializeCookie(base: string, valor: string, attrs: CookieAttrs): string {
  const partes = [`${cookieName(base, attrs)}=${encodeURIComponent(valor)}`]
  partes.push(`Path=${attrs.path}`)
  if (attrs.domain) partes.push(`Domain=${attrs.domain}`)
  if (attrs.maxAgeMs !== undefined) {
    const segundos = Math.max(0, Math.floor(attrs.maxAgeMs / 1000))
    partes.push(`Max-Age=${segundos}`)
    partes.push(`Expires=${new Date(Date.now() + segundos * 1000).toUTCString()}`)
  }
  if (attrs.httpOnly) partes.push('HttpOnly')
  if (attrs.secure) partes.push('Secure')
  const rotulo = attrs.sameSite === 'none' ? 'None' : attrs.sameSite === 'strict' ? 'Strict' : 'Lax'
  partes.push(`SameSite=${rotulo}`)
  return partes.join('; ')
}

/**
 * Cabeçalho que APAGA um cookie. Precisa repetir Path/Domain/atributos do
 * original: o navegador trata (nome, domínio, caminho) como identidade, e um
 * "apagar" com atributos diferentes cria um segundo cookie em vez de remover o
 * primeiro — a pessoa clicaria em "Sair" e continuaria entrando.
 */
export function expiredCookie(base: string, attrs: CookieAttrs): string {
  return serializeCookie(base, '', { ...attrs, maxAgeMs: 0 })
}

// ---- Atributos por requisição ----------------------------------------------

// Sufixos públicos de dois rótulos que aparecem no Brasil e arredores. Sem eles,
// "advoc.com.br" e "outro.com.br" pareceriam o mesmo site (os dois terminam em
// "com.br") e o SameSite=Lax seria aplicado a um cenário que é cross-site.
const SUFIXOS_DUPLOS = new Set([
  'com.br',
  'net.br',
  'org.br',
  'adv.br',
  'gov.br',
  'edu.br',
  'com.pt',
  'co.uk',
  'org.uk',
  'com.au',
  'com.ar',
  'com.mx',
])

/** Domínio registrável aproximado (sem baixar a Public Suffix List). */
export function siteDe(host?: string): string {
  const limpo = (host ?? '')
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/\.$/, '')
  if (!limpo) return ''
  const labels = limpo.split('.')
  if (labels.length <= 2) return limpo // localhost, advoc.me, ou um IP
  const ultimosDois = labels.slice(-2).join('.')
  return SUFIXOS_DUPLOS.has(ultimosDois) ? labels.slice(-3).join('.') : ultimosDois
}

/** O host da página que fez a chamada e o host da API são do mesmo site? */
export function mesmoSite(origin?: string, host?: string): boolean {
  if (!origin || !host) return true // sem Origin (navegação direta, curl): trate como próprio
  let originHost: string
  try {
    originHost = new URL(origin).hostname
  } catch {
    return false
  }
  const a = siteDe(originHost)
  const b = siteDe(host)
  return !!a && a === b
}

function envSameSite(): SameSite | undefined {
  const v = (process.env.AUTH_COOKIE_SAMESITE ?? '').trim().toLowerCase()
  return v === 'lax' || v === 'strict' || v === 'none' ? v : undefined
}

/** A conexão desta requisição é https (direta ou atrás do proxy)? */
export function requisicaoSegura(proto?: string): boolean {
  if (IS_PROD) return true
  if (process.env.AUTH_COOKIE_SECURE === '1') return true
  return (proto ?? '').toLowerCase().split(',')[0]?.trim() === 'https'
}

/**
 * Atributos do cookie para ESTA requisição.
 *
 * O SameSite é decidido na hora, comparando o site da página com o site da API:
 *
 *   • mesmo site (advoc.me + api.advoc.me, ou o proxy do Vite em dev) → `Lax`.
 *     É o valor seguro: o navegador simplesmente não manda o cookie num pedido
 *     partido de outro site, e o CSRF clássico morre no berço.
 *   • sites diferentes (o front no Netlify e a API na VPS, que é o deploy de
 *     hoje) → `None`, porque com Lax o cookie não seria enviado e ninguém
 *     conseguiria entrar. `None` exige `Secure` e reabre a porta do CSRF — daí a
 *     dupla defesa em csrf.ts (Origin conferido + token de dupla submissão).
 *
 * Decidir sozinho evita o pior dos mundos: uma variável de ambiente esquecida que
 * ou derruba o login (Lax onde precisa de None) ou afrouxa a proteção sem motivo
 * (None onde Lax bastava). AUTH_COOKIE_SAMESITE força o valor quando necessário.
 */
export function cookieAttrs(opts: {
  origin?: string
  host?: string
  proto?: string
  httpOnly: boolean
  maxAgeMs?: number
}): CookieAttrs {
  const secure = requisicaoSegura(opts.proto)

  let sameSite: SameSite = envSameSite() ?? (mesmoSite(opts.origin, opts.host) ? 'lax' : 'none')
  // `SameSite=None` sem `Secure` é recusado pelo navegador — o cookie sumiria em
  // silêncio. Em desenvolvimento (http), cair para Lax mantém o login de pé.
  if (sameSite === 'none' && !secure) sameSite = 'lax'

  const domain = (process.env.AUTH_COOKIE_DOMAIN ?? '').trim() || undefined

  return {
    httpOnly: opts.httpOnly,
    secure,
    sameSite,
    path: '/',
    domain,
    maxAgeMs: opts.maxAgeMs,
  }
}
