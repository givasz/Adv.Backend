// CSRF — impedir que OUTRO site use a sessão de quem está logado aqui.
//
// O problema nasce junto com o cookie: cookie é enviado pelo navegador sozinho,
// sem que a página precise pedir. Um `<form>` num site qualquer apontando para
// DELETE /api/account viajaria com a sessão do advogado anexada. Com o token no
// cabeçalho isso não acontecia — nenhum outro site consegue escrever um
// `Authorization` nosso — então a proteção abaixo é a dívida que o cookie cria.
//
// Duas barreiras, porque cada uma cobre o furo da outra:
//
//   1. SameSite (ver cookies.ts). Quando o front e a API são do mesmo site, o
//      navegador simplesmente não manda o cookie num pedido partido de fora.
//      É a barreira mais forte — mas ela NÃO existe no deploy de hoje, em que o
//      front (Netlify) e a API (VPS) são sites diferentes e o cookie precisa ser
//      `SameSite=None`.
//   2. Origin conferido + token de dupla submissão. O `Origin` diz de que página
//      o pedido partiu e o navegador não deixa forjá-lo; o token é um valor que
//      só a nossa página consegue obter (a resposta de /auth/me é protegida por
//      CORS) e que precisa vir num cabeçalho — algo que um `<form>` de outro site
//      não sabe escrever.
//
// O token é DERIVADO da sessão (HMAC), não sorteado e guardado: assim ele não
// custa uma linha de banco nem uma leitura por requisição, e ainda assim não
// pode ser inventado por quem não tem o segredo. Trocar de sessão troca o token.

import { ForbiddenException } from '@nestjs/common'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { IS_PROD, requireSecret } from '../security/config'

/** Cabeçalho onde o front devolve o token. */
export const CSRF_HEADER = 'x-csrf-token'

/** Métodos que só leem — não mudam nada, não precisam de token. */
const SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS'])

function segredo(): string {
  return requireSecret(
    [process.env.AUTH_SESSION_SECRET, process.env.ADMIN_SESSION_SECRET],
    'dev-user-secret',
  )
}

/** Token anti-CSRF desta sessão. Determinístico: mesma sessão, mesmo token. */
export function csrfTokenFor(sessionId: string): string {
  return createHmac('sha256', segredo()).update(`csrf:v1:${sessionId}`).digest('base64url')
}

function iguais(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

/** O token recebido corresponde à sessão? */
export function csrfValido(sessionId: string, recebido?: string): boolean {
  if (!recebido) return false
  try {
    return iguais(recebido, csrfTokenFor(sessionId))
  } catch {
    return false // segredo ausente em produção → nada passa
  }
}

// ---- Origem ----------------------------------------------------------------

/**
 * Origens autorizadas do front. Mesma lista que alimenta o CORS em main.ts —
 * uma lista só, porque manter duas é garantir que um dia elas discordem.
 */
export function origensPermitidas(): string[] {
  return (process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean)
}

/** Máquina local, em qualquer porta — só vale fora de produção. */
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/

/**
 * Esta origem pode falar com a API?
 *
 * Uma função, e não a lista crua, porque o desenvolvimento precisa de uma folga
 * que a produção não pode ter: o Vite sobe em 5173 quando a porta está livre e
 * em 5174, 5175… quando não está. Com a lista fixa, o app abria, o login
 * funcionava (essas rotas não têm sessão para proteger) e TODA gravação seguinte
 * voltava 403 — o perfil não salvava nada e nada na tela explicava por quê.
 *
 * Em produção nada muda: vale exatamente o que estiver em FRONTEND_ORIGIN.
 */
export function origemPermitida(origem?: string): boolean {
  if (!origem) return true // sem Origin (navegação direta, curl): não é ataque de outro site
  const limpa = origem.replace(/\/$/, '')
  if (origensPermitidas().includes(limpa)) return true
  return !IS_PROD && LOCAL.test(limpa)
}

function origemDe(url?: string): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

/**
 * De onde partiu o pedido, se dá para saber. `Origin` é o campo certo (o
 * navegador não deixa a página escrevê-lo); `Referer` entra como segunda opção
 * porque alguns clientes antigos omitem o primeiro.
 */
export function origemDoPedido(req: {
  headers: Record<string, string | string[] | undefined>
}): string | undefined {
  const h = (nome: string) => {
    const v = req.headers[nome]
    return Array.isArray(v) ? v[0] : v
  }
  return origemDe(h('origin')) ?? origemDe(h('referer'))
}

// ---- Verificação -----------------------------------------------------------

export interface PedidoCsrf {
  method: string
  origin?: string
  csrfHeader?: string
}

/**
 * Recusa o pedido quando ele tem cara de vir de fora.
 *
 * `exigirToken: false` é usado só no logout: sair é uma intenção que nunca pode
 * ficar presa. Se o token de CSRF se perdeu (aba antiga, storage limpo), a pessoa
 * ainda precisa conseguir encerrar a sessão — e forçar alguém a sair é, no pior
 * caso, um aborrecimento, não um vazamento.
 */
export function assertCsrf(
  pedido: PedidoCsrf,
  sessionId: string,
  { exigirToken = true }: { exigirToken?: boolean } = {},
): void {
  if (SEGUROS.has(pedido.method.toUpperCase())) return

  // 1. Origem: quando o navegador diz de onde veio, tem que ser de casa.
  // A mensagem NÃO ecoa a origem recebida nem cita o nome da variável de
  // ambiente: cabeçalho é entrada do cliente, e refleti-la de volta (para a
  // resposta E para o log do Nest) só servia a quem estivesse sondando.
  if (!origemPermitida(pedido.origin)) {
    throw new ForbiddenException(
      'Pedido bloqueado por segurança: a origem da chamada não é reconhecida.',
    )
  }

  // 2. Token: um formulário de outro site não consegue escrever este cabeçalho.
  if (exigirToken && !csrfValido(sessionId, pedido.csrfHeader)) {
    throw new ForbiddenException(
      'Pedido bloqueado por segurança. Atualize a página e tente novamente.',
    )
  }
}
