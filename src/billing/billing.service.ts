import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service'
import { ProfilesService } from '../profiles/profiles.service'
import {
  aoCancelar,
  aoConfirmarPagamento,
  aoFalharPagamento,
  aoPausar,
  aoRetomar,
  type PatchAssinatura,
  type Plan,
} from '../assinatura'

// Entrada dos eventos de cobrança.
//
// O PROVEDOR NÃO ENTRA AQUI. Este arquivo fala um vocabulário próprio, e cada
// provedor (Stripe, Mercado Pago, Asaas, Pagar.me) ganha um adaptador que traduz
// os eventos dele para este formato — ver `docs/cobranca.md`. Foi decisão
// consciente: enquanto o provedor não estiver escolhido, escrever contra a API de
// um deles seria adivinhação, e trocar depois obrigaria a mexer na parte que
// decide quem perde o perfil. O que está aqui é a parte que não muda.
//
// O QUE UM WEBHOOK DE COBRANÇA PRECISA TER, E POR QUÊ
//
//  • ASSINATURA. Sem conferir, a rota é um upgrade grátis para quem descobrir a
//    URL — e ela é pública por natureza, porque quem chama é um servidor de fora.
//    Sem segredo configurado, a rota RECUSA (fail closed). Uma cobrança que aceita
//    evento não assinado é pior do que uma cobrança que não funciona: a segunda
//    alguém conserta, a primeira ninguém percebe.
//  • IDEMPOTÊNCIA. Provedor repete webhook por projeto (é assim que ele garante a
//    entrega). O mesmo "pagou" processado duas vezes estende o período duas vezes.
//  • ORDEM. Webhook chega fora de ordem. Um "falhou" de ontem que chega depois do
//    "pagou" de hoje rebaixaria quem está em dia — o pior erro possível desta rota.

/** Tipos de evento que a plataforma entende. O adaptador do provedor traduz. */
export const TIPOS_DE_EVENTO = [
  'payment_succeeded',
  'payment_failed',
  'subscription_canceled',
  'subscription_paused',
  'subscription_resumed',
] as const
export type TipoDeEvento = (typeof TIPOS_DE_EVENTO)[number]

export interface EventoDeCobranca {
  /** id do evento NO PROVEDOR — é ele que faz a idempotência valer */
  id: string
  type: TipoDeEvento
  /** momento SEGUNDO O PROVEDOR (não o da chegada) — é por ele que se ordena */
  occurredAt: string
  provider?: string
  /** identificadores do provedor, para casar com o perfil */
  customerId?: string
  subscriptionId?: string
  /** e-mail da conta — último recurso para casar a PRIMEIRA assinatura */
  email?: string
  /** plano contratado (obrigatório em payment_succeeded) */
  plan?: Plan
  /** fim do período pago, ISO */
  currentPeriodEnd?: string
  /** motivo/descrição do provedor, guardado no registro */
  reason?: string
}

/** Resultado do processamento — o controller devolve isto como corpo. */
export interface ResultadoDoEvento {
  ok: true
  applied: boolean
  reason?: string
}

const CABECALHO_ASSINATURA = 'x-advocme-signature'

@Injectable()
export class BillingService {
  private readonly log = new Logger('Billing')

  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: ProfilesService,
  ) {}

  /**
   * Confere a assinatura HMAC-SHA256 do corpo CRU.
   *
   * O corpo cru, e não o JSON reserializado: `JSON.stringify(JSON.parse(x))` não
   * devolve `x` (ordem de chaves, espaços, escapes), e qualquer diferença de um
   * byte invalida o HMAC. É o erro clássico de integração de webhook.
   */
  conferirAssinatura(corpoCru: Buffer | undefined, cabecalho: string | undefined): void {
    const segredo = (process.env.BILLING_WEBHOOK_SECRET ?? '').trim()
    if (!segredo) {
      // Fail closed. Em desenvolvimento, defina BILLING_WEBHOOK_SECRET no .env —
      // um valor qualquer serve para testar, desde que o mesmo assine o pedido.
      throw new BadRequestException('Cobrança não configurada neste ambiente.')
    }
    if (!corpoCru || corpoCru.length === 0) {
      throw new BadRequestException('Corpo vazio.')
    }
    const recebida = (cabecalho ?? '').trim().replace(/^sha256=/i, '')
    const esperada = createHmac('sha256', segredo).update(corpoCru).digest('hex')
    const a = Buffer.from(recebida, 'utf8')
    const b = Buffer.from(esperada, 'utf8')
    // Comparação de tempo constante — e comprimento conferido antes, porque
    // timingSafeEqual estoura com tamanhos diferentes.
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new BadRequestException('Assinatura inválida.')
    }
  }

  /** Nome do cabeçalho onde a assinatura viaja (usado pelo controller e pelos testes). */
  static get cabecalhoDaAssinatura() {
    return CABECALHO_ASSINATURA
  }

  /** Fronteira de entrada: o corpo é JSON de fora, tudo é conferido campo a campo. */
  private sanitizar(raw: any): EventoDeCobranca {
    const texto = (v: unknown, max = 200) =>
      typeof v === 'string' ? v.trim().slice(0, max) : undefined
    const id = texto(raw?.id, 120)
    const type = TIPOS_DE_EVENTO.includes(raw?.type) ? (raw.type as TipoDeEvento) : undefined
    if (!id) throw new BadRequestException('Evento sem id.')
    if (!type) throw new BadRequestException('Tipo de evento desconhecido.')

    const quando = new Date(texto(raw?.occurredAt, 40) ?? '')
    return {
      id,
      type,
      // Sem data válida do provedor, usamos a chegada. Perde-se a ordenação fina,
      // mas o evento não é descartado — e o registro guarda o payload cru.
      occurredAt: (Number.isNaN(quando.getTime()) ? new Date() : quando).toISOString(),
      provider: texto(raw?.provider, 40),
      customerId: texto(raw?.customerId, 120),
      subscriptionId: texto(raw?.subscriptionId, 120),
      email: texto(raw?.email, 200)?.toLowerCase(),
      plan: raw?.plan === 'pro' || raw?.plan === 'premium' ? raw.plan : undefined,
      currentPeriodEnd: texto(raw?.currentPeriodEnd, 40),
      reason: texto(raw?.reason, 300),
    }
  }

  /**
   * Encontra o perfil dono do evento. Três chaves, da mais específica para a menos:
   * a assinatura, o cliente, e — só na PRIMEIRA cobrança, quando ainda não há
   * vínculo gravado — o e-mail da conta.
   */
  private async acharPerfil(ev: EventoDeCobranca) {
    const campos = {
      id: true,
      plan: true,
      planStatus: true,
      currentPeriodEnd: true,
      graceUntil: true,
      planScheduled: true,
      billingEventAt: true,
      billingCustomerId: true,
      billingSubscriptionId: true,
    } as const

    if (ev.subscriptionId) {
      const p = await this.prisma.profile.findFirst({
        where: { billingSubscriptionId: ev.subscriptionId },
        select: campos,
      })
      if (p) return p
    }
    if (ev.customerId) {
      const p = await this.prisma.profile.findFirst({
        where: { billingCustomerId: ev.customerId },
        select: campos,
      })
      if (p) return p
    }
    if (ev.email) {
      const p = await this.prisma.profile.findFirst({
        where: { user: { email: ev.email } },
        select: campos,
      })
      if (p) return p
    }
    return null
  }

  /** Evento → patch de assinatura. Toda a política de cobrança cabe aqui. */
  private patchDoEvento(ev: EventoDeCobranca, perfil: any): PatchAssinatura {
    const fim = ev.currentPeriodEnd ? new Date(ev.currentPeriodEnd) : null
    const fimValido = fim && !Number.isNaN(fim.getTime()) ? fim : null

    switch (ev.type) {
      case 'payment_succeeded': {
        // Um rebaixamento AGENDADO se realiza na renovação: a pessoa pediu para
        // descer no fim do período, o período acabou de virar, e é o plano menor
        // que está sendo cobrado agora. Sem isto, ela pagaria o menor e continuaria
        // recebendo o maior — e o agendamento nunca se cumpriria.
        const alvo: Plan = (perfil?.planScheduled as Plan) || ev.plan || (perfil?.plan as Plan) || 'free'
        return { ...aoConfirmarPagamento(alvo, fimValido), planScheduled: null }
      }
      case 'payment_failed':
        return aoFalharPagamento(perfil ?? {})
      case 'subscription_canceled':
        // O fim do período informado pelo provedor manda: é até quando ela pagou.
        return aoCancelar({ ...perfil, currentPeriodEnd: fimValido ?? perfil?.currentPeriodEnd })
      case 'subscription_paused':
        return aoPausar()
      case 'subscription_resumed':
        return aoRetomar()
    }
  }

  /**
   * Processa um evento. Devolve sempre 200 para o provedor quando o evento foi
   * ACEITO — inclusive quando não havia o que fazer. Devolver erro num evento
   * repetido ou desconhecido faz o provedor reenviar em laço e, depois de algumas
   * falhas, desligar o webhook inteiro.
   */
  async processar(raw: any, corpoCru: string): Promise<ResultadoDoEvento> {
    const ev = this.sanitizar(raw)

    // 1. IDEMPOTÊNCIA. A linha é criada ANTES de qualquer efeito: é a chave única
    //    do banco que resolve a corrida entre duas entregas simultâneas do mesmo
    //    evento, não um `findFirst` seguido de `create` (que perde a corrida).
    let registro: { id: string }
    try {
      registro = await this.prisma.billingEvent.create({
        data: {
          eventId: ev.id,
          provider: ev.provider ?? '',
          type: ev.type,
          occurredAt: new Date(ev.occurredAt),
          payload: corpoCru.slice(0, 20000),
        },
        select: { id: true },
      })
    } catch {
      // Chave única violada: já vimos este evento. Nada a fazer, e 200.
      return { ok: true, applied: false, reason: 'repetido' }
    }

    const anotar = async (note: string, applied: boolean, profileId?: string) => {
      await this.prisma.billingEvent.update({
        where: { id: registro.id },
        data: { note, applied, profileId: profileId ?? null },
      })
      return { ok: true as const, applied, reason: note }
    }

    // 2. DONO. Evento sem perfil correspondente fica registrado para quem for
    //    depurar — some num log que roda, não.
    const perfil = await this.acharPerfil(ev)
    if (!perfil) return anotar('perfil não encontrado', false)

    // 3. ORDEM. Evento mais antigo que o último aplicado é registrado e ignorado.
    const ultimo = perfil.billingEventAt ? new Date(perfil.billingEventAt).getTime() : 0
    if (new Date(ev.occurredAt).getTime() < ultimo) {
      return anotar('fora de ordem (mais antigo que o último aplicado)', false, perfil.id)
    }

    // 4. EFEITO. Uma porta só, a mesma do checkout e da varredura — o que garante
    //    que tema e agendamento sejam reconciliados junto com o plano.
    const patch = this.patchDoEvento(ev, perfil)
    await this.profiles.aplicarAssinaturaPorPerfil(
      perfil.id,
      patch,
      `cobrança: ${ev.type}${ev.reason ? ` (${ev.reason})` : ''}`,
    )

    // 5. VÍNCULO E MARCA D'ÁGUA DO EVENTO. Gravados fora do patch de assinatura
    //    porque não são estado de plano: são a costura com o provedor.
    await this.prisma.profile.update({
      where: { id: perfil.id },
      data: {
        billingEventId: ev.id,
        billingEventAt: new Date(ev.occurredAt),
        ...(ev.customerId && !perfil.billingCustomerId ? { billingCustomerId: ev.customerId } : {}),
        ...(ev.subscriptionId && !perfil.billingSubscriptionId
          ? { billingSubscriptionId: ev.subscriptionId }
          : {}),
      },
    })

    this.log.log(`evento ${ev.type} aplicado ao perfil ${perfil.id}`)
    return anotar('aplicado', true, perfil.id)
  }
}
