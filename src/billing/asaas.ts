// ADAPTADOR DO ASAAS — tradução, e só tradução.
//
// Este arquivo existe porque `billing.service.ts` fala um vocabulário próprio, de
// propósito: cinco tipos de evento que descrevem o que a ASSINATURA sofreu, sem
// uma linha sobre qual empresa processa o cartão. Trocar de provedor não pode
// obrigar a mexer na parte que decide quem perde o perfil.
//
// Esta é a segunda vez que a promessa é cobrada. O adaptador da Pagar.me foi
// escrito em 10/09/2026 e substituído por este em 29/09; o núcleo — estados,
// carência, varredura, idempotência, ordenação — não mudou uma linha. Funciona.
//
// ---------------------------------------------------------------------------
// A FRONTEIRA, E POR QUE ELA FICOU MELHOR
//
// A Pagar.me não autenticava o webhook de jeito nenhum, e por isso o segredo
// precisou ir no CAMINHO da URL — onde ele aparece em log de proxy, em print de
// tela do painel e em qualquer conversa em que alguém mande esse print (foi o que
// aconteceu no mesmo dia).
//
// O Asaas manda um cabeçalho `asaas-access-token` com um valor que NÓS definimos
// ao cadastrar o webhook (32 a 255 caracteres). Cabeçalho não entra em log de
// acesso e não aparece na barra de endereço. A URL passa a ser pública e chata:
// o segredo está no cabeçalho, onde devia estar desde o começo.
//
// Sem token configurado a rota RECUSA TUDO. Uma cobrança que aceita evento não
// autenticado é pior do que uma cobrança que não funciona: a segunda alguém
// conserta, a primeira ninguém percebe.
//
// A LISTA de tokens aceitos também é o que separa ambientes. Sandbox e produção
// são CONTAS diferentes no Asaas, cada uma com o seu webhook e o seu token. O
// servidor de produção conhece só o token de produção, então um pagamento de
// mentira do sandbox bate em 401 e não encosta em plano nenhum. Na Pagar.me isso
// precisou de uma trava extra por id de conta; aqui é consequência do desenho.
// ---------------------------------------------------------------------------

import { timingSafeEqual } from 'node:crypto'
import { BadRequestException, UnauthorizedException } from '@nestjs/common'
import type { EventoDeCobranca, TipoDeEvento } from './billing.service'
import type { Plan } from '../assinatura'

export const PROVEDOR = 'asaas'

/** Cabeçalho onde o Asaas manda o token que nós cadastramos no webhook. */
export const CABECALHO_TOKEN = 'asaas-access-token'

export function tokensDeWebhookValidos(env: NodeJS.ProcessEnv = process.env): string[] {
  const tokens = (env.ASAAS_WEBHOOK_TOKEN ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!tokens.length || tokens.some((token) => token.length < 32 || token.length > 255)) return []
  const apiKey = (env.ASAAS_API_KEY ?? '').trim()
  if (apiKey && tokens.includes(apiKey)) return []
  return tokens
}

const CAMPOS_SENSIVEIS = new Set(
  [
    'accessToken',
    'address',
    'addressNumber',
    'authorization',
    'ccv',
    'city',
    'complement',
    'creditCardHolderInfo',
    'creditcardnumber',
    'creditcardtoken',
    'cpfcnpj',
    'cvv',
    'email',
    'expirymonth',
    'expiryyear',
    'holderName',
    'mobilephone',
    'name',
    'number',
    'phone',
    'postalcode',
    'province',
  ].map((campo) => campo.toLowerCase().replace(/[^a-z0-9]/g, '')),
)

/**
 * O webhook do Asaas pode trazer `creditCardToken` e dados do titular. Eles nao
 * sao necessarios para conciliacao e nunca devem entrar no registro de auditoria.
 */
export function payloadSeguroParaAuditoria(raw: unknown): string {
  const limpar = (valor: unknown, profundidade: number): unknown => {
    if (profundidade > 12) return '[TRUNCADO]'
    if (Array.isArray(valor)) return valor.slice(0, 100).map((item) => limpar(item, profundidade + 1))
    if (!valor || typeof valor !== 'object') {
      return typeof valor === 'string' ? valor.slice(0, 2_000) : valor
    }
    const seguro: Record<string, unknown> = {}
    for (const [chave, conteudo] of Object.entries(valor as Record<string, unknown>).slice(0, 200)) {
      const normalizada = chave.toLowerCase().replace(/[^a-z0-9]/g, '')
      seguro[chave] = CAMPOS_SENSIVEIS.has(normalizada) ? '[REMOVIDO]' : limpar(conteudo, profundidade + 1)
    }
    return seguro
  }

  return JSON.stringify(limpar(raw, 0))
}

/**
 * O que cada evento do Asaas significa para a assinatura.
 *
 * A lista é DELIBERADAMENTE curta. O Asaas manda dezenas de eventos
 * (`PAYMENT_CREATED`, `PAYMENT_BANK_SLIP_VIEWED`, `PAYMENT_CHECKOUT_VIEWED`…) e
 * nenhum deles muda o direito de uso de ninguém: só "entrou dinheiro", "não
 * entrou" e "acabou" mexem no plano.
 *
 * POR QUE `PAYMENT_CONFIRMED` **E** `PAYMENT_RECEIVED` VALEM O MESMO
 *
 * No Asaas são coisas diferentes: confirmado é "o pagamento aconteceu", recebido
 * é "o dinheiro caiu na conta". No cartão essa distância é de cerca de 30 dias.
 * Liberar o plano só no recebido faria o advogado pagar hoje e usar no mês que
 * vem — inaceitável. Então vale o CONFIRMADO.
 *
 * E o recebido precisa valer também, porque o Pix **pula** o confirmado: o fluxo
 * dele é `PAYMENT_CREATED` → `PAYMENT_RECEIVED`. Tratar só um dos dois deixaria
 * metade dos meios de pagamento sem liberar nada.
 *
 * Aplicar os dois não estende o período duas vezes: `aoConfirmarPagamento` GRAVA
 * a data que calculamos, não soma um mês ao que estava lá. E a idempotência por
 * `eventId` barra o mesmo evento repetido — o Asaas entrega "pelo menos uma vez",
 * então repetição é rotina, não exceção.
 *
 * Estorno e chargeback revogam o acesso imediatamente: o período que havia sido
 * concedido por aquele dinheiro não continua válido depois da reversão.
 */
const MAPA: Record<string, TipoDeEvento> = {
  PAYMENT_CONFIRMED: 'payment_succeeded',
  PAYMENT_RECEIVED: 'payment_succeeded',
  // Vencido é o nosso "falhou": abre a carência de 7 dias e NÃO tira nada do ar.
  // É o estado em que o Asaas ainda cobra e em que nós avisamos.
  PAYMENT_OVERDUE: 'payment_failed',
  PAYMENT_CREDIT_CARD_CAPTURE_REFUSED: 'payment_failed',
  PAYMENT_REPROVED_BY_RISK_ANALYSIS: 'payment_failed',
  PAYMENT_REFUNDED: 'payment_reversed',
  PAYMENT_CHARGEBACK_REQUESTED: 'payment_reversed',
  SUBSCRIPTION_DELETED: 'subscription_canceled',
  SUBSCRIPTION_INACTIVATED: 'subscription_canceled',
}

/** Envelope do webhook do Asaas: `{ id, event, dateCreated, payment | subscription }`. */
export interface EnvelopeAsaas {
  /** `evt_...` — é ele que faz a idempotência valer */
  id: string
  /** o tipo CRU do Asaas, guardado como veio no registro do evento */
  event: string
  /** `dateCreated` do topo, em ISO */
  occurredAt: string
  /** o objeto do evento (uma cobrança ou uma assinatura) */
  recurso: Record<string, unknown>
}

function texto(v: unknown, max = 200): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined
}

function objeto(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function numero(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : Number.NaN
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/**
 * Data tolerante. O Asaas manda `dueDate` como `2026-10-29` (só o dia) e
 * `dateCreated` com hora — os dois viram ISO aqui.
 */
function iso(v: unknown): string | undefined {
  const s = texto(v, 40)
  if (!s) return undefined
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00.000Z` : s)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

/**
 * Lê o envelope. Falha alto e cedo: um corpo sem `id` ou sem `event` não é um
 * webhook do Asaas, e fingir que é só adiaria a confusão para dentro do banco.
 */
export function lerEnvelope(raw: unknown): EnvelopeAsaas {
  const corpo = objeto(raw)
  const id = texto(corpo.id, 120)
  const event = texto(corpo.event, 80)
  if (!id) throw new BadRequestException('Evento sem id.')
  if (!event) throw new BadRequestException('Evento sem tipo.')
  return {
    id,
    event,
    // Sem data válida no topo, vale a chegada. Perde-se a ordenação fina entre
    // eventos, mas o evento não é jogado fora — e o payload saneado fica guardado.
    occurredAt: iso(corpo.dateCreated) ?? new Date().toISOString(),
    // Cobrança e assinatura chegam em chaves diferentes conforme o evento.
    recurso: { ...objeto(corpo.subscription), ...objeto(corpo.payment) },
  }
}

// ---- De quem é este dinheiro ---------------------------------------------------

/**
 * `externalReference` — o carimbo que NÓS pomos na assinatura, e a melhor coisa
 * que o Asaas tem que a Pagar.me não tinha.
 *
 * Formato: `advocme:<id do perfil>:<plano>`.
 *
 * Sem ele, achar o dono do pagamento dependia de casar o e-mail da conta — e
 * casar por e-mail é o caminho por onde um pagamento errado (ou forjado) dá plano
 * à pessoa errada. Com o carimbo, o evento diz de quem é, sem adivinhação.
 *
 * O plano vai junto pelo mesmo motivo: na hora em que o pagamento é confirmado,
 * o que decide o que liberar é o que foi COMPRADO, não o que a pessoa tinha.
 */
export function marcaExterna(profileId: string, plano: Plan): string {
  return `advocme:${profileId}:${plano}`
}

export function lerMarca(v: unknown): { profileId?: string; plan?: Plan } {
  const s = texto(v, 200)
  if (!s) return {}
  const [prefixo, profileId, plano] = s.split(':')
  if (prefixo !== 'advocme' || !profileId) return {}
  return { profileId, plan: plano === 'pro' || plano === 'premium' ? plano : undefined }
}

/**
 * O cliente e a assinatura no Asaas, procurados em todos os lugares plausíveis.
 *
 * Numa cobrança, `customer` e `subscription` costumam vir como STRING (o id). Num
 * evento de assinatura, o objeto É a assinatura. Em vez de um `if` por tipo de
 * evento — que quebra em silêncio no dia em que o Asaas acrescentar um caminho —,
 * cada identificador é procurado do mais específico para o menos.
 */
function idDe(...valores: unknown[]): string | undefined {
  for (const v of valores) {
    const s = texto(v, 120) ?? texto(objeto(v).id, 120)
    if (s) return s
  }
  return undefined
}

/**
 * ATÉ QUANDO o que foi pago cobre.
 *
 * O Asaas não manda isso na cobrança: ele manda o `dueDate` DESTE ciclo. O fim do
 * período pago é o vencimento do ciclo SEGUINTE, e todos os nossos planos são
 * mensais (ver plans.ts) — então é o vencimento mais um mês.
 *
 * Usamos `dueDate`, não `paymentDate`: quem paga com três dias de atraso não
 * ganha três dias a mais de assinatura, e a âncora da cobrança continua no mesmo
 * dia do mês, que é como o Asaas gera os ciclos.
 *
 * Num evento de ASSINATURA, quando existe `nextDueDate`, ele manda — é a resposta
 * do próprio provedor, melhor que a nossa conta.
 *
 * Sem data nenhuma, devolve `undefined` e NÃO inventa: sem prazo, `valeAte()`
 * entende "sem prazo" e o acesso fica de pé. É o lado certo para errar quando o
 * provedor foi omisso — uma data chutada aqui vira rebaixamento na varredura de
 * daqui a seis horas.
 */
function fimDoPeriodoDe(r: Record<string, unknown>): string | undefined {
  return iso(r.nextDueDate) ?? fimDoPeriodoPorVencimento(r.dueDate)
}

/**
 * Vencimento deste ciclo + 1 mês. Exportado porque o checkout, quando o cartão é
 * confirmado na hora, ativa o plano sem esperar o webhook — e tem de gravar
 * EXATAMENTE a data que o webhook gravaria logo depois. Duas contas para a mesma
 * data é como elas começam a divergir.
 */
export function fimDoPeriodoPorVencimento(vencimento: unknown): string | undefined {
  const vence = iso(vencimento)
  if (!vence) return undefined
  const d = new Date(vence)
  const dia = d.getUTCDate()
  d.setUTCMonth(d.getUTCMonth() + 1)
  // 31/01 + 1 mês viraria 03/03 no JavaScript. Quem vence dia 31 vence no último
  // dia do mês seguinte, não em março.
  if (d.getUTCDate() !== dia) d.setUTCDate(0)
  return d.toISOString()
}

/** O motivo da recusa, para o registro — é o que responde "por que não entrou?". */
function motivoDe(r: Record<string, unknown>): string | undefined {
  return (
    texto(r.creditCardTransactionFailureReason, 300) ??
    texto(objeto(r.creditCard).transactionFailureReason, 300) ??
    texto(r.status, 300)
  )
}

/**
 * Envelope do Asaas → nosso `EventoDeCobranca`.
 *
 * Devolve `null` para evento que não muda assinatura nenhuma. Não é erro: é a
 * maioria do tráfego, e o chamador ainda assim REGISTRA o evento (ver o
 * controller). Registrar tudo e aplicar pouco é o que permite responder, meses
 * depois, "o que exatamente eles nos contaram naquele dia".
 */
export function traduzir(env: EnvelopeAsaas): EventoDeCobranca | null {
  const type = MAPA[env.event]
  if (!type) return null
  const r = env.recurso
  const marca = lerMarca(r.externalReference)
  return {
    id: env.id,
    type,
    occurredAt: env.occurredAt,
    provider: PROVEDOR,
    profileId: marca.profileId,
    customerId: idDe(r.customer),
    subscriptionId: idDe(r.subscription, texto(r.object) === 'subscription' ? r.id : undefined),
    plan: marca.plan,
    amount: numero(r.value),
    currentPeriodEnd: fimDoPeriodoDe(r),
    reason: motivoDe(r),
  }
}

// ---- A porta -------------------------------------------------------------------

function igual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  // Comprimento conferido antes: `timingSafeEqual` estoura com tamanhos diferentes.
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * Confere o `asaas-access-token`.
 *
 * `ASAAS_WEBHOOK_TOKEN` aceita uma lista separada por vírgula, e é ela que separa
 * os ambientes: em produção entra SÓ o token do webhook de produção, então o
 * sandbox — que é outra conta, com outro token — bate em 401 e não mexe em plano
 * nenhum. Uma máquina de desenvolvimento pode aceitar os dois.
 *
 * Sem token configurado, recusa tudo. Fail closed.
 */
export function conferirEntrada(recebido: string | undefined): void {
  const aceitos = tokensDeWebhookValidos()
  if (!aceitos.length) throw new UnauthorizedException('Cobrança não configurada neste ambiente.')
  const token = (recebido ?? '').trim()
  // `some` com comparação de tempo constante em cada item: a lista tem dois
  // elementos no pior caso, e vazar por tempo qual deles casou não diz nada.
  if (!token || !aceitos.some((a) => igual(token, a))) {
    throw new UnauthorizedException('Credencial inválida.')
  }
}
