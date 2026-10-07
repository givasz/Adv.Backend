import { BadRequestException, ConflictException, Injectable, Logger, Optional } from '@nestjs/common'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service'
import { ProfilesService } from '../profiles/profiles.service'
import { PLAN_PRICE } from '../plans'
import { BillingLockService } from './billing-lock'
import { PartnersService } from '../partners/partners.service'
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
  'payment_reversed',
  'subscription_canceled',
  'subscription_paused',
  'subscription_resumed',
] as const
export type TipoDeEvento = (typeof TIPOS_DE_EVENTO)[number]

export interface EventoDeCobranca {
  /** id do evento NO PROVEDOR — é ele que faz a idempotência valer */
  id: string
  /**
   * id do PAGAMENTO no provedor (o `payment.id` do Asaas), nos eventos de
   * pagamento. Não confundir com `id`: PAYMENT_CONFIRMED e PAYMENT_RECEIVED do
   * MESMO pagamento chegam com ids de evento diferentes e este id igual. É ele que
   * o Programa Parceiros usa para não recompensar duas vezes o mesmo dinheiro.
   */
  paymentId?: string
  type: TipoDeEvento
  /** momento SEGUNDO O PROVEDOR (não o da chegada) — é por ele que se ordena */
  occurredAt: string
  provider?: string
  /**
   * O id do PERFIL, quando o provedor devolve uma referência que nós mesmos
   * gravamos (o `externalReference` do Asaas). É a chave mais forte de todas:
   * não depende de o provedor ter guardado o vínculo, nem de o e-mail casar.
   */
  profileId?: string
  /** identificadores do provedor, para casar com o perfil */
  customerId?: string
  subscriptionId?: string
  /** e-mail da conta — último recurso para casar a PRIMEIRA assinatura */
  email?: string
  /** plano contratado (obrigatório em payment_succeeded) */
  plan?: Plan
  /** valor efetivamente informado pelo provedor, em reais */
  amount?: number
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
const EVENTO_PENDENTE_EXPIRA_MS = 10 * 60 * 1000

function chaveUnicaViolada(erro: unknown): boolean {
  return !!erro && typeof erro === 'object' && (erro as { code?: unknown }).code === 'P2002'
}

@Injectable()
export class BillingService {
  private readonly log = new Logger('Billing')

  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: ProfilesService,
    private readonly lock: BillingLockService,
    // Opcional só para os testes anteriores ao programa. No app vem do PartnersModule.
    @Optional() private readonly partners?: PartnersService,
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

  /**
   * Guarda um evento SEM aplicar nada.
   *
   * Serve ao adaptador de provedor (ver `asaas.controller.ts`) para o tráfego
   * que não mexe em assinatura — `charge.created`, visualização de boleto etc. É a maior
   * parte do que um provedor manda, e jogar fora seria perder a única resposta
   * possível para "o que exatamente eles nos contaram naquele dia".
   *
   * Passa pela MESMA chave única dos eventos aplicados, então repetido continua
   * sendo repetido, e o `type` guardado aqui é o do PROVEDOR (o vocabulário da
   * casa só existe para o que a gente trata).
   */
  async registrarBruto(dados: {
    id: string
    provider: string
    type: string
    occurredAt: string
    payload: string
    note: string
  }): Promise<ResultadoDoEvento> {
    try {
      await this.prisma.billingEvent.create({
        data: {
          eventId: dados.id.slice(0, 120),
          provider: dados.provider.slice(0, 40),
          type: dados.type.slice(0, 80),
          occurredAt: new Date(dados.occurredAt),
          payload: dados.payload.slice(0, 20000),
          applied: false,
          note: dados.note,
        },
        select: { id: true },
      })
    } catch (erro) {
      if (chaveUnicaViolada(erro)) return { ok: true, applied: false, reason: 'repetido' }
      throw erro
    }
    return { ok: true, applied: false, reason: dados.note }
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
      // mas o evento não é descartado — e o registro guarda o payload auditável.
      occurredAt: (Number.isNaN(quando.getTime()) ? new Date() : quando).toISOString(),
      provider: texto(raw?.provider, 40),
      paymentId: texto(raw?.paymentId, 120),
      profileId: texto(raw?.profileId, 60),
      customerId: texto(raw?.customerId, 120),
      subscriptionId: texto(raw?.subscriptionId, 120),
      email: texto(raw?.email, 200)?.toLowerCase(),
      plan: raw?.plan === 'pro' || raw?.plan === 'premium' ? raw.plan : undefined,
      amount: typeof raw?.amount === 'number' && Number.isFinite(raw.amount) ? raw.amount : undefined,
      currentPeriodEnd: texto(raw?.currentPeriodEnd, 40),
      reason: texto(raw?.reason, 300),
    }
  }

  /**
   * Encontra o perfil dono do evento. Quatro chaves, da mais específica para a
   * menos: a referência nossa que o provedor devolve (o perfil em si), a
   * assinatura, o cliente, e — só na PRIMEIRA cobrança, quando ainda não há
   * vínculo gravado — o e-mail da conta.
   *
   * O e-mail é o elo fraco: é por ele que um pagamento errado daria plano à
   * pessoa errada. Por isso fica por último, e por isso o adaptador do Asaas
   * carimba o perfil no `externalReference` — com ele, o e-mail nunca é consultado.
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

    if (ev.profileId) {
      const p = await this.prisma.profile.findFirst({ where: { id: ev.profileId }, select: campos })
      if (p) return p
    }
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
      case 'payment_reversed': {
        if (perfil?.planStatus === 'canceled') return aoCancelar(perfil)
        return aoCancelar({ ...perfil, currentPeriodEnd: new Date(ev.occurredAt) })
      }
      case 'subscription_canceled': {
        // CANCELAMENTO QUE PARTIU DAQUI já gravou a data certa, e o aviso do
        // provedor não a muda. É o caso do arrependimento: o valor é devolvido e o
        // plano termina na hora (MinhaAssinaturaService.cancelar). O aviso de
        // assinatura apagada chega segundos depois trazendo a data da próxima
        // cobrança — e, sem esta regra, devolveria um mês a quem acabou de
        // receber o dinheiro de volta.
        if (perfil?.planStatus === 'canceled') return aoCancelar(perfil)
        // Cancelamento que partiu do PROVEDOR (apagado no painel, ou ele desistiu
        // de cobrar): o fim do período informado por ele manda — é até quando a
        // pessoa pagou, mesmo que o aviso do último pagamento tenha se perdido.
        return aoCancelar({ ...perfil, currentPeriodEnd: fimValido ?? perfil?.currentPeriodEnd })
      }
      case 'subscription_paused':
        return aoPausar()
      case 'subscription_resumed':
        return aoRetomar()
    }
  }

  /**
   * O pagamento confirmado chega ao Programa Parceiros. Uma falha aqui NÃO desfaz a
   * cobrança: a assinatura já foi aplicada, e um erro do programa não pode fazer o
   * provedor reenviar o evento em laço até desligar o webhook. Fica no log.
   */
  private async avisarPagamentoAoPrograma(ev: EventoDeCobranca, profileId: string, billingEventId: string) {
    if (!this.partners || !ev.paymentId) return
    try {
      await this.partners.registrarConversao({
        profileId,
        plan: ev.plan,
        amount: ev.amount,
        paymentId: ev.paymentId,
        billingEventId,
        occurredAt: ev.occurredAt,
      })
    } catch (e) {
      this.log.error(`programa parceiros (conversão) falhou no evento ${ev.id}: ${e instanceof Error ? e.message : e}`)
    }
  }

  private async avisarEstornoAoPrograma(ev: EventoDeCobranca) {
    if (!this.partners || !ev.paymentId) return
    try {
      await this.partners.revogarPorPagamento(ev.paymentId, `estorno ou contestação do pagamento (${ev.reason ?? 'sem motivo informado'})`)
    } catch (e) {
      // Revogação perdida é dia de Max indevido, não dinheiro: o console revoga à
      // mão. Bloquear o estorno da ASSINATURA por isso seria pior.
      this.log.error(`programa parceiros (estorno) falhou no evento ${ev.id}: ${e instanceof Error ? e.message : e}`)
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
    } catch (erro) {
      // Chave única violada: uma entrega concluída é repetida; uma ainda sem nota
      // está sendo processada por outra requisição e não pode receber um falso 200.
      if (chaveUnicaViolada(erro)) {
        const existente = await this.prisma.billingEvent.findUnique({
          where: { eventId: ev.id },
          select: { applied: true, note: true, createdAt: true },
        })
        if (!existente) throw erro
        if (existente && !existente.applied && !existente.note) {
          if (Date.now() - existente.createdAt.getTime() >= EVENTO_PENDENTE_EXPIRA_MS) {
            // Um processo pode morrer entre o INSERT e a anotação final. Só apaga
            // se a linha continuar pendente; assim a próxima entrega pode refazer.
            await this.prisma.billingEvent.deleteMany({
              where: { eventId: ev.id, applied: false, note: '' },
            })
            throw new ConflictException('Evento abandonado liberado; aguarde a retentativa.')
          }
          throw new ConflictException('Evento de cobrança ainda em processamento.')
        }
        return { ok: true, applied: false, reason: 'repetido' }
      }
      throw erro
    }

    try {
      // ESTORNO E CHARGEBACK valem para o Programa Parceiros pelo PAGAMENTO, antes
      // de qualquer conferência de assinatura: um estorno de uma assinatura antiga
      // (ou de um evento "fora de ordem") continua sendo dinheiro que voltou. A
      // revogação é idempotente — a segunda entrega encontra a recompensa revogada.
      if (ev.type === 'payment_reversed') await this.avisarEstornoAoPrograma(ev)

      const anotar = async (note: string, applied: boolean, profileId?: string) => {
        await this.prisma.billingEvent.update({
          where: { id: registro.id },
          data: { note, applied, profileId: profileId ?? null },
        })
        return { ok: true as const, applied, reason: note }
      }

      // 2. DONO. Evento sem perfil correspondente fica registrado para quem for
      //    depurar — some num log que roda, não.
      const candidato = await this.acharPerfil(ev)
      if (!candidato) return anotar('perfil não encontrado', false)

      return await this.lock.comPerfil(candidato.id, async () => {
        // Releitura já com a trava: outro evento pode ter mudado o vínculo ou a
        // marca temporal entre a primeira busca e a aquisição do mutex.
        const perfil = await this.acharPerfil(ev)
        if (!perfil) return anotar('perfil não encontrado após adquirir a trava', false)

        // A referência externa contém o perfil, mas ela é reutilizada quando uma
        // assinatura é substituída. Um aviso atrasado da assinatura antiga não pode
        // cancelar ou rebaixar a que está valendo agora.
        if (
          ev.subscriptionId &&
          perfil.billingSubscriptionId &&
          ev.subscriptionId !== perfil.billingSubscriptionId
        ) {
          return anotar('assinatura diferente da assinatura atual', false, perfil.id)
        }
        if (
          ev.customerId &&
          perfil.billingCustomerId &&
          ev.customerId !== perfil.billingCustomerId
        ) {
          return anotar('cliente diferente do cliente de cobrança atual', false, perfil.id)
        }

        if (ev.provider === 'asaas' && ev.type === 'payment_succeeded') {
          const esperado =
            ev.plan === 'pro' || ev.plan === 'premium' ? PLAN_PRICE[ev.plan] : undefined
          const recebido = ev.amount
          if (
            esperado === undefined ||
            recebido === undefined ||
            Math.round(recebido * 100) !== Math.round(esperado * 100)
          ) {
            return anotar('valor divergente do plano', false, perfil.id)
          }
        }

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
        const podeVincular = ev.type === 'payment_succeeded' || ev.type === 'payment_failed'
        await this.prisma.profile.update({
          where: { id: perfil.id },
          data: {
            billingEventId: ev.id,
            billingEventAt: new Date(ev.occurredAt),
            ...(podeVincular && ev.customerId && !perfil.billingCustomerId
              ? { billingCustomerId: ev.customerId }
              : {}),
            ...(podeVincular && ev.subscriptionId && !perfil.billingSubscriptionId
              ? { billingSubscriptionId: ev.subscriptionId }
              : {}),
          },
        })

        // 6. PROGRAMA PARCEIROS. Só depois de tudo validado e aplicado: token,
        //    perfil, assinatura, cliente, valor e ordem. O mesmo método do checkout
        //    imediato; repetição (CONFIRMED + RECEIVED, ou checkout + webhook) é
        //    resolvida pelo id do PAGAMENTO, não pelo do evento.
        if (ev.type === 'payment_succeeded') await this.avisarPagamentoAoPrograma(ev, perfil.id, registro.id)

        this.log.log(`evento ${ev.type} aplicado ao perfil ${perfil.id}`)
        return anotar('aplicado', true, perfil.id)
      })
    } catch (erro) {
      // Só um evento completamente processado pode ocupar a chave idempotente.
      // Se qualquer passo falhar, a retentativa do provedor precisa conseguir
      // executar o mesmo evento outra vez em vez de receber um falso "repetido".
      await this.prisma.billingEvent.delete({ where: { id: registro.id } }).catch(() => undefined)
      throw erro
    }
  }
}
