// Entrar com o Google — o lado do servidor.
//
// O desenho em uma frase: o navegador vai ao Google e VOLTA PARA O SERVIDOR, que
// troca o código pela identidade da pessoa usando a chave secreta (que nunca sai
// daqui) e só então deixa a página abrir a sessão — pelo mesmo cookie HttpOnly
// do login por senha. Nada do Google passa pelo JavaScript da página.
//
// Por que não o "One Tap" / botão do Google Identity Services, que entrega o
// token direto à página: o token passaria pelo JavaScript, e conferir a
// assinatura dele pediria as chaves públicas do Google (dependência nova, cache
// de chaves girando). No fluxo de código a identidade chega numa conversa
// servidor a servidor, por TLS, autenticada pela chave secreta e pelo PKCE — e a
// OpenID Connect (Core 1.0, 3.1.3.7, item 6) aceita essa conversa no lugar da
// conferência de assinatura.
//
// Três travas contra quem tenta se meter no meio do caminho:
//   • state — a resposta que volta do Google é a do pedido que partiu DESTE
//             navegador. Sem ele, alguém faria a vítima entrar na conta dele
//             (login CSRF) e colheria o que ela digitasse ali.
//   • PKCE  — um código interceptado no caminho não vale nada sem o verificador,
//             que só existe no cookie deste navegador.
//   • nonce — o token de identidade foi emitido para ESTE pedido, e não
//             reaproveitado de outro.
//
// Pedimos só `openid email profile`: nome, e-mail e se o Google o confirmou. É o
// escopo "não sensível" — nada de Gmail, Drive ou agenda —, o que dispensa a
// verificação de segurança do Google e cabe no que a Política de Privacidade diz.
//
// Configuração (env):
//   GOOGLE_CLIENT_ID      console.cloud.google.com → Credenciais → ID do cliente
//                         OAuth do tipo "Aplicativo da Web"
//   GOOGLE_CLIENT_SECRET  a chave secreta do mesmo cliente
// O endereço de retorno NÃO é variável: é SITE_URL + /api/auth/google/retorno, e
// precisa estar cadastrado exatamente assim no console do Google.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { TERMS_VERSION } from '../legal/termos'
import { urlDoSite } from '../mail/config'
import { NAME_MAX } from '../plans'
import { requireSecret } from '../security/config'
import { EMAIL_MAX } from '../security/sanitize'

/**
 * A partir de qual versão dos documentos a Política de Privacidade declara a
 * entrada com o Google. `null` = ainda não declara, e em produção o botão não
 * aparece. Mesmo mecanismo de CORREIO_NA_POLITICA_DESDE (mail/config.ts), com a
 * mesma trava de paridade em legal/termos.spec.ts.
 */
export const GOOGLE_NA_POLITICA_DESDE: string | null = '2026-09-12-2'

/** A versão vigente dos documentos já declara a entrada com o Google? */
export function politicaDeclaraGoogle(
  versao: string = TERMS_VERSION,
  desde: string | null = GOOGLE_NA_POLITICA_DESDE,
): boolean {
  // Versões ISO comparam como texto, sufixo incluído: "2026-09-12" < "2026-09-12-2".
  return desde !== null && versao >= desde
}

/** Para onde o Google devolve a pessoa (rota da API, atrás do proxy do site). */
export const CAMINHO_DE_RETORNO = '/api/auth/google/retorno'
/** A tela do front que termina o fluxo. */
export const PAGINA_DE_CONCLUSAO = '/entrar/google'

/** Cookie que guarda o pedido em andamento e, na volta, a identidade conferida. */
export const GOOGLE_COOKIE = 'advocme_google'
/** Só as rotas do Google o recebem — nenhuma outra chamada da API carrega isto. */
export const CAMINHO_DO_COOKIE = '/api/auth/google'
/** Tempo para ir ao Google, escolher a conta e voltar; e depois, para aceitar os Termos. */
export const VALIDADE_MS = 10 * 60 * 1000

export interface ConfigDoGoogle {
  ativo: boolean
  clientId: string
  clientSecret: string
  /** Base do site (a mesma dos links de e-mail). Nunca vem do pedido. */
  siteUrl: string
  /** O endereço que precisa estar cadastrado no console do Google. */
  redirectUri: string
  /** Por que está desligado. */
  aviso: string
}

export function configDoGoogle(env: NodeJS.ProcessEnv = process.env): ConfigDoGoogle {
  const prod = env.NODE_ENV === 'production'
  const clientId = (env.GOOGLE_CLIENT_ID ?? '').trim()
  const clientSecret = (env.GOOGLE_CLIENT_SECRET ?? '').trim()
  // O mesmo endereço dos links de e-mail, pelo mesmo motivo: montar o retorno a
  // partir do Host do pedido deixaria quem forja o cabeçalho escolher para onde o
  // Google devolve a pessoa.
  const siteUrl = urlDoSite(env)
  const redirectUri = siteUrl ? `${siteUrl}${CAMINHO_DE_RETORNO}` : ''
  const base = { clientId, clientSecret, siteUrl, redirectUri }
  const desligado = (aviso: string): ConfigDoGoogle => ({ ...base, ativo: false, aviso })

  if (!clientId && !clientSecret) return desligado('GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET ausentes.')
  if (!clientId) return desligado('GOOGLE_CLIENT_ID ausente.')
  if (!clientSecret) return desligado('GOOGLE_CLIENT_SECRET ausente.')
  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    return desligado('GOOGLE_CLIENT_ID não parece um ID do Google (termina em .apps.googleusercontent.com).')
  }
  if (!siteUrl) return desligado('SITE_URL/FRONTEND_ORIGIN não é um endereço http(s) válido.')
  if (prod) {
    if (!politicaDeclaraGoogle()) {
      return desligado(
        'a Política de Privacidade ainda não declara a entrada com o Google. ' +
          'Ver GOOGLE_NA_POLITICA_DESDE em src/auth/google.ts.',
      )
    }
    if (!siteUrl.startsWith('https://')) return desligado('SITE_URL precisa ser https em produção.')
  }
  return { ...base, ativo: true, aviso: '' }
}

/** A linha do boot. Nada de chave: só o que ajuda a conferir o deploy. */
export function descreverGoogle(c: ConfigDoGoogle): string {
  if (!c.ativo) return `DESLIGADO — ${c.aviso} O botão "Continuar com o Google" não aparece.`
  return `ligado · retorno em ${c.redirectUri} (tem de estar cadastrado igual no console do Google)`
}

// ---- O pedido -----------------------------------------------------------------

export interface PedidoGoogle {
  state: string
  nonce: string
  /** Verificador do PKCE. O Google recebe só o hash dele (o desafio). */
  verifier: string
}

/** Sorteia state, nonce e verificador — 256 bits cada. */
export function novoPedido(): PedidoGoogle {
  const sorteio = () => randomBytes(32).toString('base64url')
  return { state: sorteio(), nonce: sorteio(), verifier: sorteio() }
}

/** Desafio S256 do PKCE: base64url(sha256(verificador)). */
export function desafioPkce(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/** Endereço da tela do Google para onde o navegador é mandado. */
export function urlDeAutorizacao(c: ConfigDoGoogle, p: PedidoGoogle): string {
  const q = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: p.state,
    nonce: p.nonce,
    code_challenge: desafioPkce(p.verifier),
    code_challenge_method: 'S256',
    // Advogado costuma ter a conta pessoal e a do escritório no mesmo navegador.
    // Perguntar qual evita entrar com a errada sem perceber — e criar uma segunda
    // conta aqui com o e-mail que não era para ser.
    prompt: 'select_account',
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`
}

/** O `state` que voltou é o do pedido guardado? Comparação em tempo constante. */
export function stateConfere(guardado: string, recebido: unknown): boolean {
  return typeof recebido === 'string' && iguais(guardado, recebido)
}

// ---- A volta --------------------------------------------------------------------

/**
 * Troca o código pelo token de identidade, servidor a servidor.
 *
 * O erro nunca carrega o corpo da resposta: numa troca que deu certo pela metade
 * ele pode trazer token, e mensagem de erro vai parar em log.
 */
export async function trocarCodigo(
  c: ConfigDoGoogle,
  code: string,
  verifier: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const res = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: c.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }).toString(),
    // O proxy do Netlify corta em 26 s; o Google responde em milissegundos. Dez
    // segundos é folga para um soluço de rede, e ainda sobra tempo de mandar a
    // pessoa de volta com uma mensagem em vez de uma tela de gateway.
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`o Google recusou a troca do código (HTTP ${res.status})`)
  const dados = (await res.json().catch(() => null)) as { id_token?: unknown } | null
  if (typeof dados?.id_token !== 'string') throw new Error('o Google respondeu sem token de identidade')
  return dados.id_token
}

export interface IdentidadeGoogle {
  /** Identificador estável da conta Google. É ele que liga as duas contas — não o e-mail. */
  sub: string
  /** Minúsculo. Só chega aqui confirmado pelo Google. */
  email: string
  /** Pode vir vazio. */
  nome: string
}

export type LeituraDoToken =
  | { ok: true; identidade: IdentidadeGoogle }
  | { ok: false; motivo: 'invalido' | 'email-nao-confirmado' }

const EMISSORES = new Set(['https://accounts.google.com', 'accounts.google.com'])
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** Relógio da VPS e do Google nunca batem ao segundo. */
const FOLGA_S = 120

/**
 * Lê e confere as declarações do token de identidade.
 *
 * A assinatura NÃO é conferida, e isso é deliberado — ver o topo do arquivo: o
 * token veio da resposta direta do Google à troca do código, por TLS, e não
 * passou pelo navegador. O que se confere é que ele é PARA NÓS (aud), DO GOOGLE
 * (iss), DESTE PEDIDO (nonce) e ainda vale (exp). Receber um token por qualquer
 * outro caminho e passar por aqui seria um erro — esta função não serve para isso.
 *
 * E-mail não confirmado pelo Google é recusado: é o e-mail que liga a pessoa a
 * uma conta que já existe, e um endereço que ninguém provou ter entregaria a
 * conta de outra pessoa.
 */
export function lerIdToken(
  idToken: string,
  esperado: { clientId: string; nonce: string; agora?: number },
): LeituraDoToken {
  const invalido: LeituraDoToken = { ok: false, motivo: 'invalido' }
  const partes = idToken.split('.')
  if (partes.length !== 3 || !partes[1]) return invalido

  let c: Record<string, unknown>
  try {
    const lido: unknown = JSON.parse(Buffer.from(partes[1], 'base64url').toString('utf8'))
    if (!lido || typeof lido !== 'object' || Array.isArray(lido)) return invalido
    c = lido as Record<string, unknown>
  } catch {
    return invalido
  }

  const agora = Math.floor((esperado.agora ?? Date.now()) / 1000)
  if (!EMISSORES.has(String(c.iss))) return invalido
  const aud = c.aud
  const paraNos =
    aud === esperado.clientId ||
    (Array.isArray(aud) && aud.includes(esperado.clientId) && c.azp === esperado.clientId)
  if (!paraNos) return invalido
  if (typeof c.exp !== 'number' || c.exp + FOLGA_S < agora) return invalido
  if (typeof c.iat === 'number' && c.iat - FOLGA_S > agora) return invalido
  if (typeof c.nonce !== 'string' || !iguais(c.nonce, esperado.nonce)) return invalido
  if (typeof c.sub !== 'string' || !/^[\w-]{1,255}$/.test(c.sub)) return invalido

  const email = typeof c.email === 'string' ? c.email.trim().toLowerCase() : ''
  if (!email || email.length > EMAIL_MAX || !EMAIL_RE.test(email)) return invalido
  // O Google manda booleano; tokens antigos mandavam o texto "true".
  if (c.email_verified !== true && c.email_verified !== 'true') {
    return { ok: false, motivo: 'email-nao-confirmado' }
  }

  const nome = typeof c.name === 'string' ? c.name.trim().slice(0, NAME_MAX) : ''
  return { ok: true, identidade: { sub: c.sub, email, nome } }
}

// ---- O cookie selado --------------------------------------------------------------

/**
 * O que o cookie guarda em cada fase. A finalidade vai DENTRO do selo: um cookie
 * do pedido não pode ser apresentado como identidade conferida, nem o contrário.
 */
export type Finalidade = 'pedido' | 'identidade'

function segredo(): string {
  return requireSecret(
    [process.env.AUTH_SESSION_SECRET, process.env.ADMIN_SESSION_SECRET],
    'dev-user-secret',
  )
}

function assinar(corpo: string): string {
  return createHmac('sha256', segredo()).update(`google:v1:${corpo}`).digest('base64url')
}

function iguais(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

/**
 * Sela um valor para o cookie: JSON em base64url + HMAC + prazo.
 *
 * O selo é o que impede a pior falha possível deste fluxo. Na volta, o cookie
 * diz "o Google confirmou que esta pessoa é fulano@…"; se esse valor pudesse ser
 * escrito à mão, bastaria montar um cookie com o e-mail de outra pessoa para
 * entrar na conta dela. HttpOnly não protege disso — quem forja é o dono do
 * próprio navegador. A assinatura protege.
 */
export function selar(finalidade: Finalidade, dados: object, validadeMs: number, agora = Date.now()): string {
  const corpo = Buffer.from(JSON.stringify({ f: finalidade, exp: agora + validadeMs, d: dados })).toString('base64url')
  return `${corpo}.${assinar(corpo)}`
}

/** Abre um selo. Assinatura errada, finalidade trocada ou prazo vencido → null. */
export function abrirSelo<T>(valor: string | undefined, finalidade: Finalidade, agora = Date.now()): T | null {
  if (!valor || valor.length > 4096) return null
  const ponto = valor.lastIndexOf('.')
  if (ponto < 1) return null
  const corpo = valor.slice(0, ponto)
  try {
    if (!iguais(valor.slice(ponto + 1), assinar(corpo))) return null
    const aberto = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8')) as {
      f?: unknown
      exp?: unknown
      d?: unknown
    }
    if (aberto?.f !== finalidade || typeof aberto.exp !== 'number' || aberto.exp <= agora) return null
    if (!aberto.d || typeof aberto.d !== 'object') return null
    return aberto.d as T
  } catch {
    return null // segredo ausente em produção, base64 quebrado, JSON quebrado
  }
}

/**
 * Para onde a pessoa vai depois de entrar. Só caminho interno — a mesma regra de
 * `caminhoDeVolta` no front (components/ui/SubPage.tsx): sem ela, o `next` que
 * atravessa o Google viraria trampolim para um site de fora.
 */
export function destinoSeguro(raw: unknown, padrao = '/painel'): string {
  const destino = typeof raw === 'string' ? raw.trim() : ''
  if (!destino.startsWith('/') || destino.length > 300) return padrao
  if (/^\/[/\\]/.test(destino)) return padrao
  // eslint-disable-next-line no-control-regex
  if (/[ -]/.test(destino)) return padrao
  return destino
}

/** O que viaja no cookie entre a ida e a volta do Google. */
export interface PedidoGuardado extends PedidoGoogle {
  lembrar: boolean
  next: string
}

/** O que viaja no cookie entre a volta do Google e a tela que abre a sessão. */
export interface IdentidadeGuardada extends IdentidadeGoogle {
  lembrar: boolean
  next: string
}
