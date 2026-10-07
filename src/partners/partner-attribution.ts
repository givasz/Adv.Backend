// A ATRIBUIÇÃO DE UMA CONTA NOVA A UM PARCEIRO — o cookie e as regras dele.
//
// O caminho: alguém abre advoc.me/r/<código>, a página chama
// POST /api/partners/attribution, e este arquivo grava um cookie ASSINADO dizendo
// "este navegador chegou pelo parceiro X, em tal instante". Se a pessoa criar uma
// conta NOVA em até 30 dias — por senha ou pelo Google —, a conta nasce ligada a X.
//
// POR QUE ASSINADO: o cookie decide quem ganha dias de Max. Escrito à mão, ele
// daria a qualquer pessoa o poder de atribuir a própria conta nova a quem
// quisesse, com a data que quisesse. O HMAC tem domínio próprio
// ("partner-ref:v1:") — um selo do Google ou de sessão não vale aqui, nem o
// contrário — e o instante de emissão vem do NOSSO relógio, dentro do selo.
//
// POR QUE DOIS COOKIES. O que o cadastro lê vive em `Path=/api/auth` (só as rotas
// de cadastro e do Google o recebem; nenhuma visita a perfil público o carrega).
// Mas o navegador não manda esse cookie para /api/partners/attribution, e a regra
// é first-touch: um segundo link aberto depois NÃO pode trocar o parceiro. Então
// a rota de captura grava também uma MARCA com o mesmo selo, em
// `Path=/api/partners/attribution`, e é por ela que sabe que já há atribuição.
//
// O QUE NUNCA ENTRA AQUI: nome, e-mail, OAB ou qualquer dado de quem indicou ou
// de quem foi indicado. O selo leva o id interno da participação, a data e um
// número sorteado — e nada disso é logado.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { authDe, type RequisicaoComAuth } from '../auth/session-context'
import { requireSecret } from '../security/config'
import { ATRIBUICAO_DIAS } from './partner-terms'

export const REF_COOKIE = 'advocme_ref'
export const REF_COOKIE_PATH = '/api/auth'
export const REF_MARCA_COOKIE = 'advocme_ref_ft'
export const REF_MARCA_PATH = '/api/partners/attribution'

const DIA_MS = 24 * 60 * 60 * 1000
export const VALIDADE_DA_ATRIBUICAO_MS = ATRIBUICAO_DIAS * DIA_MS
/** Folga para relógio de servidor que andou para trás entre dois processos. */
const FOLGA_DE_RELOGIO_MS = 5 * 60 * 1000

/** Formato do código: base64url, sem nada que dê para reconhecer. */
const CODIGO = /^[A-Za-z0-9_-]{16,64}$/
/** Formato do id interno da participação (cuid). */
const ID = /^[a-z0-9]{8,40}$/i

interface SeloDeAtribuicao {
  v: 1
  /** id da PartnerMembership */
  p: string
  /** emitido em (ms), pelo NOSSO relógio */
  iat: number
  /** sorteado — dois selos do mesmo parceiro nunca são iguais */
  n: string
}

export interface Atribuicao {
  partnerId: string
  emitidaEm: Date
}

/** Código novo: 16 bytes sorteados. Nunca derivado de slug, nome, e-mail ou OAB. */
export function novoCodigo(): string {
  return randomBytes(16).toString('base64url')
}

/** O código como veio da URL, se tiver a forma de um código — senão `null`. */
export function codigoValido(bruto: unknown): string | null {
  return typeof bruto === 'string' && CODIGO.test(bruto) ? bruto : null
}

function segredo(): string {
  return requireSecret(
    [process.env.AUTH_SESSION_SECRET, process.env.ADMIN_SESSION_SECRET],
    'dev-user-secret',
  )
}

function assinar(corpo: string): string {
  return createHmac('sha256', segredo()).update(`partner-ref:v1:${corpo}`).digest('base64url')
}

function iguais(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

export function selarAtribuicao(partnerId: string, agora = Date.now()): string {
  const selo: SeloDeAtribuicao = { v: 1, p: partnerId, iat: agora, n: randomBytes(9).toString('base64url') }
  const corpo = Buffer.from(JSON.stringify(selo)).toString('base64url')
  return `${corpo}.${assinar(corpo)}`
}

/** Abre o selo. Assinatura errada, versão estranha ou prazo de 30 dias vencido → `null`. */
export function abrirAtribuicao(valor: string | undefined, agora = Date.now()): Atribuicao | null {
  if (!valor || valor.length > 512) return null
  const ponto = valor.lastIndexOf('.')
  if (ponto < 1) return null
  const corpo = valor.slice(0, ponto)
  try {
    if (!iguais(valor.slice(ponto + 1), assinar(corpo))) return null
    const selo = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8')) as Partial<SeloDeAtribuicao>
    if (selo?.v !== 1 || typeof selo.p !== 'string' || !ID.test(selo.p)) return null
    if (typeof selo.iat !== 'number' || !Number.isFinite(selo.iat)) return null
    if (selo.iat > agora + FOLGA_DE_RELOGIO_MS) return null
    if (agora - selo.iat >= VALIDADE_DA_ATRIBUICAO_MS) return null
    return { partnerId: selo.p, emitidaEm: new Date(selo.iat) }
  } catch {
    return null // segredo ausente em produção, base64 ou JSON quebrados
  }
}

/** A atribuição que este navegador traz para o cadastro, se houver uma válida. */
export function lerAtribuicao(req: RequisicaoComAuth | undefined, agora = Date.now()): Atribuicao | null {
  return abrirAtribuicao(authDe(req).cookie(REF_COOKIE), agora)
}

/** Este navegador já tem uma atribuição válida? (lido na rota de captura, pela marca) */
export function temAtribuicaoValida(req: RequisicaoComAuth | undefined, agora = Date.now()): boolean {
  return abrirAtribuicao(authDe(req).cookie(REF_MARCA_COOKIE), agora) !== null
}

export function gravarAtribuicao(req: RequisicaoComAuth | undefined, selo: string): void {
  const auth = authDe(req)
  const comum = { httpOnly: true, maxAgeMs: VALIDADE_DA_ATRIBUICAO_MS }
  auth.setCookie(REF_COOKIE, selo, { ...comum, path: REF_COOKIE_PATH })
  auth.setCookie(REF_MARCA_COOKIE, selo, { ...comum, path: REF_MARCA_PATH })
}

/** Consumida (conta criada): os dois cookies saem, com os mesmos atributos. */
export function limparAtribuicao(req: RequisicaoComAuth | undefined): void {
  const auth = authDe(req)
  auth.clearCookie(REF_COOKIE, { httpOnly: true, path: REF_COOKIE_PATH })
  auth.clearCookie(REF_MARCA_COOKIE, { httpOnly: true, path: REF_MARCA_PATH })
}

/** O mínimo do Prisma que a conferência usa — os testes passam um dublê. */
interface PrismaDeAtribuicao {
  partnerMembership: {
    findUnique(args: {
      where: { id: string }
      select: { id: true; status: true; profile: { select: { userId: true } } }
    }): Promise<{ id: string; status: string; profile: { userId: string } | null } | null>
  }
}

/**
 * A atribuição ainda vale para uma conta que está nascendo AGORA?
 *
 * Só participação ATIVA atribui: convidada, suspensa ou encerrada, a conta nasce
 * normal — sem erro, sem aviso, sem trava no cadastro. E ninguém indica a si
 * mesmo (a conta nova nunca é a do parceiro, mas a conferência fica aqui para o
 * dia em que alguém chamar isto de outro lugar).
 */
export async function parceiroQueAtribui(
  prisma: PrismaDeAtribuicao,
  atribuicao: Atribuicao | null,
  novoUserId?: string,
): Promise<string | null> {
  if (!atribuicao) return null
  try {
    const m = await prisma.partnerMembership.findUnique({
      where: { id: atribuicao.partnerId },
      select: { id: true, status: true, profile: { select: { userId: true } } },
    })
    if (!m || m.status !== 'active') return null
    if (novoUserId && m.profile?.userId === novoUserId) return null
    return m.id
  } catch {
    // Banco instável na hora do cadastro: a conta nasce sem indicação. O
    // cadastro nunca pode cair por causa do programa.
    return null
  }
}
