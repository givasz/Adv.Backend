// ADAPTADOR DA PAGAR.ME — tradução, e só tradução.
//
// Este arquivo existe porque `billing.service.ts` fala um vocabulário próprio, de
// propósito: cinco tipos de evento que descrevem o que a ASSINATURA sofreu, sem
// uma linha sobre qual empresa processa o cartão. Trocar de provedor não pode
// obrigar a mexer na parte que decide quem perde o perfil.
//
// Então o provedor entra aqui, e para aqui. Tudo o que este arquivo faz é pegar o
// que a Pagar.me manda e devolver o nosso `EventoDeCobranca`. Funções puras, sem
// banco e sem Nest — a tradução de webhook é onde erro de integração mora, e essa
// é a parte que dá para testar sem servidor nenhum.
//
// ---------------------------------------------------------------------------
// POR QUE A PAGAR.ME NÃO PODE APONTAR PARA /api/billing/webhook
//
// Aquela rota exige HMAC-SHA256 do corpo cru no cabeçalho `x-advocme-signature`.
// A Pagar.me NÃO assina o corpo: no painel dela a autenticação do webhook é um
// campo opcional, não uma assinatura criptográfica do payload. Não há como ela
// produzir o cabeçalho que a nossa rota exige.
//
// Daí esta segunda porta, com a fronteira que a Pagar.me consegue atravessar:
// um segredo longo no CAMINHO da URL e/ou Basic Auth. As duas são conferidas em
// tempo constante, e SEM NENHUMA DAS DUAS CONFIGURADAS A ROTA RECUSA TUDO —
// mesma regra da outra porta, pelo mesmo motivo: uma cobrança que aceita evento
// não autenticado é pior do que uma cobrança que não funciona. A segunda alguém
// conserta; a primeira ninguém percebe.
// ---------------------------------------------------------------------------

import { timingSafeEqual } from 'node:crypto'
import { BadRequestException, UnauthorizedException } from '@nestjs/common'
import type { EventoDeCobranca, TipoDeEvento } from './billing.service'
import type { Plan } from '../assinatura'

export const PROVEDOR = 'pagarme'

/**
 * O que cada evento da Pagar.me significa para a assinatura.
 *
 * A lista é DELIBERADAMENTE curta. A Pagar.me manda dezenas de eventos
 * (`charge.created`, `charge.processing`, `charge.antifraud_pending`…) e nenhum
 * deles muda o direito de uso de ninguém: só "entrou dinheiro", "não entrou" e
 * "acabou" mexem no plano. Tratar mais do que isso é abrir caminho para um
 * `charge.pending` rebaixar alguém.
 *
 * Os `invoice.*` estão aqui junto com os `charge.*` porque, numa assinatura, a
 * Pagar.me anuncia o ciclo pelos dois. Aplicar os dois não estende o período duas
 * vezes: `aoConfirmarPagamento` GRAVA a data que o provedor informou, não soma um
 * mês ao que estava lá. Dois eventos dizendo "o período vai até 28/10" deixam o
 * período indo até 28/10 — e a idempotência por `eventId` já barra o mesmo evento
 * repetido.
 *
 * `charge.refunded` e chargeback ficam de fora por escolha: estorno é conversa,
 * não automação. Fica registrado (ver `registrarBruto`) e alguém olha.
 */
const MAPA: Record<string, TipoDeEvento> = {
  'charge.paid': 'payment_succeeded',
  'invoice.paid': 'payment_succeeded',
  'charge.payment_failed': 'payment_failed',
  'invoice.payment_failed': 'payment_failed',
  'subscription.canceled': 'subscription_canceled',
}

/** Envelope do webhook da Pagar.me: `{ id, account, type, created_at, data }`. */
export interface EnvelopePagarme {
  /** `hook_...` — é ele que faz a idempotência valer */
  id: string
  /** o tipo CRU da Pagar.me, guardado como veio no registro do evento */
  type: string
  /** `created_at` do topo, em ISO */
  occurredAt: string
  /** o objeto do evento (uma charge, uma invoice, uma subscription) */
  data: Record<string, unknown>
  /** `acc_...` — de QUAL conta da Pagar.me o evento veio (ver `contaAutorizada`) */
  accountId?: string
}

function texto(v: unknown, max = 200): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined
}

function objeto(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** Data tolerante: a Pagar.me manda ISO, mas um campo ausente não pode derrubar o evento. */
function iso(v: unknown): string | undefined {
  const s = texto(v, 40)
  if (!s) return undefined
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

/**
 * Lê o envelope. Falha alto e cedo: um corpo sem `id` ou sem `type` não é um
 * webhook da Pagar.me, e fingir que é só adiaria a confusão para dentro do banco.
 */
export function lerEnvelope(raw: unknown): EnvelopePagarme {
  const corpo = objeto(raw)
  const id = texto(corpo.id, 120)
  const type = texto(corpo.type, 80)
  if (!id) throw new BadRequestException('Evento sem id.')
  if (!type) throw new BadRequestException('Evento sem tipo.')
  return {
    id,
    type,
    // Sem data válida no topo, vale a chegada. Perde-se a ordenação fina entre
    // eventos, mas o evento não é jogado fora — e o payload cru fica guardado.
    occurredAt: iso(corpo.created_at) ?? new Date().toISOString(),
    data: objeto(corpo.data),
    accountId: texto(objeto(corpo.account).id, 120) ?? texto(corpo.account_id, 120),
  }
}

/**
 * O evento veio da conta que este servidor atende?
 *
 * POR QUE EXISTE: há UM backend só, o de produção, e a Pagar.me separa teste e
 * produção em CONTAS diferentes — cada uma com o seu webhook, e as duas capazes de
 * apontar para o mesmo endereço. Sem esta trava, um pagamento FALSO feito no
 * ambiente de teste com o e-mail de uma conta real (o do próprio dono, no primeiro
 * teste que alguém fizer) daria plano Max de verdade a essa pessoa: `acharPerfil`
 * casa pelo e-mail, e o token da URL é o mesmo.
 *
 * O token prova que quem chama conhece a URL. Esta trava prova que o dinheiro é da
 * conta certa. São perguntas diferentes, e só a segunda separa teste de produção.
 *
 * `PAGARME_ACCOUNT_ID` aceita uma lista separada por vírgula. Sem ela configurada,
 * NADA é aplicado — o evento só é registrado. Fail closed, como as trancas da porta:
 * um servidor sem a conta definida não sabe distinguir teste de produção, e na
 * dúvida o certo é não mexer no plano de ninguém.
 */
export function contaAutorizada(env: EnvelopePagarme): { ok: true } | { ok: false; motivo: string } {
  const aceitas = (process.env.PAGARME_ACCOUNT_ID ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!aceitas.length) return { ok: false, motivo: 'PAGARME_ACCOUNT_ID não configurada' }
  if (!env.accountId) return { ok: false, motivo: 'evento sem conta' }
  if (!aceitas.includes(env.accountId)) {
    return { ok: false, motivo: `conta não autorizada: ${env.accountId}` }
  }
  return { ok: true }
}

// ---- Onde a Pagar.me esconde cada identificador --------------------------------
//
// O mesmo dado aparece em lugares diferentes conforme o evento: numa `charge` o
// cliente está em `data.customer`, numa `invoice` a assinatura está em
// `data.subscription`, e numa `subscription` o objeto É a assinatura. Em vez de
// um `if` por tipo de evento — que quebra silenciosamente no dia em que a
// Pagar.me acrescentar um caminho —, cada identificador é procurado em TODOS os
// lugares plausíveis, do mais específico para o menos.
//
// Isto é defensivo de propósito: a forma exata do payload de assinatura não está
// publicada com exemplo na documentação (a página de exemplo só mostra
// `order.paid`). O primeiro evento de verdade que chegar do ambiente de teste
// fica gravado em `BillingEvent.payload`, e aí a lista abaixo é conferida contra
// o que a Pagar.me realmente manda, não contra o que supomos.

function primeiro(...valores: unknown[]): string | undefined {
  for (const v of valores) {
    const s = texto(v, 120)
    if (s) return s
  }
  return undefined
}

function subscriptionIdDe(d: Record<string, unknown>): string | undefined {
  const invoice = objeto(d.invoice)
  const sub = objeto(d.subscription)
  return primeiro(
    // o objeto É a assinatura (subscription.canceled)
    texto(d.object) === 'subscription' ? d.id : undefined,
    d.subscription_id,
    sub.id,
    invoice.subscription_id,
    objeto(invoice.subscription).id,
  )
}

function customerIdDe(d: Record<string, unknown>): string | undefined {
  return primeiro(
    objeto(d.customer).id,
    d.customer_id,
    objeto(objeto(d.invoice).customer).id,
    objeto(objeto(d.subscription).customer).id,
  )
}

function emailDe(d: Record<string, unknown>): string | undefined {
  const e = primeiro(
    objeto(d.customer).email,
    objeto(objeto(d.invoice).customer).email,
    objeto(objeto(d.subscription).customer).email,
  )
  return e?.toLowerCase().slice(0, 200)
}

/**
 * Fim do período pago.
 *
 * `next_billing_at` é a resposta certa numa assinatura pré-paga: é o dia em que a
 * Pagar.me vai cobrar de novo, ou seja, exatamente até quando o que foi pago
 * cobre. `current_period.end_at` é o mesmo dia dito de outro jeito.
 *
 * Quando nada disso vier, devolvemos `undefined` e NÃO inventamos data. Uma data
 * chutada aqui vira rebaixamento na varredura de daqui a seis horas; sem data,
 * `valeAte()` devolve "sem prazo" e o acesso fica de pé — o lado certo para
 * errar quando o provedor foi omisso.
 */
function fimDoPeriodoDe(d: Record<string, unknown>): string | undefined {
  const sub = objeto(d.subscription)
  const invoice = objeto(d.invoice)
  return (
    iso(d.next_billing_at) ??
    iso(objeto(d.current_period).end_at) ??
    iso(sub.next_billing_at) ??
    iso(objeto(sub.current_period).end_at) ??
    iso(objeto(invoice.subscription).next_billing_at) ??
    iso(invoice.due_at)
  )
}

/**
 * Qual plano foi pago.
 *
 * Vem de `metadata.plano`, que é NOSSO — gravado por nós no momento em que a
 * assinatura é criada. Não do nome nem do id do plano na Pagar.me: o nome é texto
 * que alguém edita no painel numa tarde, e no dia em que "Pro" virar "Profissional"
 * a tradução passaria a devolver `undefined` sem ninguém notar.
 *
 * Quando não vier, `BillingService` usa o plano que a pessoa já tem contratado —
 * que é o comportamento certo numa RENOVAÇÃO, o caso mais comum de todos.
 */
function planoDe(d: Record<string, unknown>): Plan | undefined {
  const meta = {
    ...objeto(objeto(d.subscription).metadata),
    ...objeto(objeto(d.invoice).metadata),
    ...objeto(d.metadata),
  }
  const p = texto(meta.plano, 20) ?? texto(meta.plan, 20)
  return p === 'pro' || p === 'premium' ? p : undefined
}

/** O motivo da recusa, para o registro — é o que responde "por que meu cartão falhou?". */
function motivoDe(d: Record<string, unknown>): string | undefined {
  const t = objeto(d.last_transaction)
  return primeiro(t.acquirer_message, t.gateway_response_message, d.status_reason, d.status)?.slice(
    0,
    300,
  )
}

/**
 * Envelope da Pagar.me → nosso `EventoDeCobranca`.
 *
 * Devolve `null` para evento que não muda assinatura nenhuma. Não é erro: é a
 * maioria do tráfego, e o chamador ainda assim REGISTRA o evento (ver o
 * controller). Registrar tudo e aplicar pouco é o que permite responder, meses
 * depois, "o que exatamente a Pagar.me nos contou naquele dia".
 */
export function traduzir(env: EnvelopePagarme): EventoDeCobranca | null {
  const type = MAPA[env.type]
  if (!type) return null
  const d = env.data
  return {
    id: env.id,
    type,
    occurredAt: env.occurredAt,
    provider: PROVEDOR,
    customerId: customerIdDe(d),
    subscriptionId: subscriptionIdDe(d),
    email: emailDe(d),
    plan: planoDe(d),
    currentPeriodEnd: fimDoPeriodoDe(d),
    reason: motivoDe(d),
  }
}

// ---- A fronteira ---------------------------------------------------------------

function igual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  // Comprimento conferido antes: `timingSafeEqual` estoura com tamanhos diferentes.
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * Confere quem está batendo na porta. Duas trancas, e basta configurar uma:
 *
 *  • PAGARME_WEBHOOK_TOKEN — segredo longo no fim da URL do webhook.
 *  • PAGARME_WEBHOOK_BASIC — "usuario:senha", conferido contra o `Authorization`.
 *    É o campo de autenticação opcional do painel da Pagar.me, e é a tranca
 *    PREFERIDA quando estiver disponível: cabeçalho não entra em log de acesso
 *    de proxy, caminho de URL entra. Se as duas estiverem configuradas, as duas
 *    são exigidas.
 *
 * Nenhuma configurada = 401 em tudo. Fail closed, como a outra porta.
 */
export function conferirEntrada(token: string | undefined, authorization: string | undefined): void {
  const esperadoToken = (process.env.PAGARME_WEBHOOK_TOKEN ?? '').trim()
  const esperadoBasic = (process.env.PAGARME_WEBHOOK_BASIC ?? '').trim()

  if (!esperadoToken && !esperadoBasic) {
    throw new UnauthorizedException('Cobrança não configurada neste ambiente.')
  }

  if (esperadoToken && !igual((token ?? '').trim(), esperadoToken)) {
    throw new UnauthorizedException('Credencial inválida.')
  }

  if (esperadoBasic) {
    const cru = (authorization ?? '').trim()
    const base64 = /^basic\s+(.+)$/i.exec(cru)?.[1] ?? ''
    let recebido = ''
    try {
      recebido = Buffer.from(base64, 'base64').toString('utf8')
    } catch {
      recebido = ''
    }
    if (!igual(recebido, esperadoBasic)) {
      throw new UnauthorizedException('Credencial inválida.')
    }
  }
}
