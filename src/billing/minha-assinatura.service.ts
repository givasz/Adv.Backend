// MINHA ASSINATURA — o que o advogado faz com a assinatura depois de assinar:
// ver, trocar de plano, trocar o cartão, cancelar.
//
// O checkout (checkout.service.ts) faz nascer a assinatura. Este arquivo cuida da
// vida dela. As duas coisas falam com o Asaas pela mesma AsaasApi e gravam plano
// pela mesma porta (ProfilesService.aplicarAssinaturaPorPerfil) — a regra do
// projeto é que plano só muda por um caminho.
//
// ---------------------------------------------------------------------------
// O DIREITO DE ARREPENDIMENTO NÃO É UM FORMULÁRIO
//
// Os Termos dizem: em até 7 dias da primeira contratação, o valor volta inteiro
// (CDC, art. 49). Promessa que depende de alguém pedir, esperar resposta e
// convencer um atendente é promessa quebrada com outro nome. Então ela é
// automática: quem cancela dentro do prazo recebe a devolução na hora, pelo
// próprio Asaas, e o plano termina ali. A tela diz isso ANTES do clique.
//
// Quando a devolução automática falha (no Pix, logo depois do recebimento, o
// saldo pode ser menor que o valor), o cancelamento acontece mesmo assim — nada
// mais é cobrado — e a devolução vira um chamado no suporte, visível para a
// equipe E para o advogado, com o valor escrito. Ele fica sabendo exatamente o
// que aconteceu e onde acompanhar.
//
// ---------------------------------------------------------------------------
// TROCAR DE PLANO
//
//  • SUBIR vale na hora. A diferença do mês já pago não é cobrada: o valor novo
//    começa na próxima cobrança. Cobrar proporcional seria mais "correto" e muito
//    mais confuso — e a regra simples é a que o advogado consegue conferir.
//  • DESCER é agendado para o fim do mês já pago (aoTrocarPlano, assinatura.ts):
//    ninguém paga o Max e recebe o Pro no dia seguinte.
//  • Voltar ao Free é cancelar.
//
// No Asaas, trocar de plano é mudar o valor da assinatura. No CARTÃO isso pode
// exigir a tokenização habilitada na conta (a documentação diz que sim; o sandbox
// tem, a produção pode não ter). Quando o Asaas recusa, a troca pede o cartão de
// novo e nasce uma assinatura nova, com a primeira cobrança no dia em que a
// antiga cobraria — nunca antes, para ninguém pagar duas vezes o mesmo mês.

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { ProfilesService } from '../profiles/profiles.service'
import { PLAN_NAME, PLAN_PRICE } from '../plans'
import {
  aoCancelar,
  aoTrocarPlano,
  planoVigente,
  somarDias,
  valeAte,
  type Plan,
  type PlanStatus,
} from '../assinatura'
import { AsaasApi, AsaasErro, type CobrancaAsaas, type MeioDePagamento } from './asaas.api'
import { marcaExterna } from './asaas'
import { limparCartao } from './checkout.service'

/** Prazo do direito de arrependimento (CDC, art. 49), em dias corridos. */
export const PRAZO_ARREPENDIMENTO_DIAS = 7

const PAGAS = new Set(['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH'])
const EM_ABERTO = new Set(['PENDING', 'OVERDUE'])

export interface ResumoDaAssinatura {
  /** O pagamento on-line está ligado neste servidor? */
  online: boolean
  /** O que foi contratado. */
  plano: Plan
  /** O que vale agora (pode ser menor, se a cobrança falhou e a carência acabou). */
  vigente: Plan
  status: PlanStatus
  validoAte: string | null
  planScheduled: Plan | null
  assinatura: null | {
    meio: MeioDePagamento
    valor: number
    /** yyyy-mm-dd — `null` depois de cancelada */
    proximaCobranca: string | null
    cartao?: { final?: string; bandeira?: string }
    emAberto: null | {
      vencimento: string
      valor: number
      vencida: boolean
      fatura?: string
      boleto?: string
      pix?: { imagem: string; copiaECola: string }
    }
    /** até quando cancelar devolve o valor pago (ISO) — `null` fora do prazo */
    arrependimentoAte: string | null
  }
}

export interface ResultadoDoCancelamento {
  ok: true
  /** até quando o plano ainda vale — `null` quando termina agora */
  valeAte: string | null
  /** 'feita' = devolvido pelo Asaas agora; 'pendente' = virou chamado no suporte */
  devolucao: 'feita' | 'pendente' | null
  valorDevolvido: number
}

/**
 * Até quando cancelar ainda devolve o dinheiro — ou `null`.
 *
 * Só vale para a PRIMEIRA cobrança paga da assinatura (é "a primeira
 * contratação" dos Termos): quem já renovou uma vez não está mais se
 * arrependendo de contratar, está cancelando. Conta a partir de quando o
 * pagamento foi confirmado, não do vencimento.
 */
export function prazoDeArrependimento(pagas: CobrancaAsaas[], agora = new Date()): Date | null {
  if (pagas.length !== 1) return null
  const c = pagas[0]
  const quando = c.confirmedDate ?? c.paymentDate ?? c.clientPaymentDate ?? c.dueDate
  const base = new Date(/^\d{4}-\d{2}-\d{2}$/.test(quando ?? '') ? `${quando}T23:59:59-03:00` : (quando ?? ''))
  if (Number.isNaN(base.getTime())) return null
  const prazo = somarDias(base, PRAZO_ARREPENDIMENTO_DIAS)
  return prazo.getTime() >= agora.getTime() ? prazo : null
}

function reais(v: number): string {
  return `R$ ${v.toFixed(2).replace('.', ',')}`
}

@Injectable()
export class MinhaAssinaturaService {
  private readonly log = new Logger('MinhaAssinatura')

  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: ProfilesService,
    private readonly asaas: AsaasApi,
  ) {}

  private async perfilDe(userId: string) {
    const perfil = await this.prisma.profile.findUnique({
      where: { userId },
      select: {
        id: true,
        name: true,
        plan: true,
        planStatus: true,
        currentPeriodEnd: true,
        graceUntil: true,
        planScheduled: true,
        billingCustomerId: true,
        billingSubscriptionId: true,
        user: { select: { email: true } },
      },
    })
    if (!perfil) throw new NotFoundException('Perfil não encontrado')
    return perfil
  }

  private falhaDoAsaas(e: unknown, mensagem: string): never {
    if (e instanceof AsaasErro && e.status === 400 && e.descricao) throw new BadRequestException(e.descricao)
    if (e instanceof AsaasErro) throw new ServiceUnavailableException(mensagem)
    throw e
  }

  // ---- Ver -------------------------------------------------------------------

  async resumo(userId: string, agora = new Date()): Promise<ResumoDaAssinatura> {
    const perfil = await this.perfilDe(userId)
    const fim = valeAte(perfil as any)
    const base: ResumoDaAssinatura = {
      online: this.asaas.configurado,
      plano: perfil.plan as Plan,
      vigente: planoVigente(perfil as any, agora),
      status: perfil.planStatus as PlanStatus,
      validoAte: fim ? fim.toISOString() : null,
      planScheduled: (perfil.planScheduled as Plan | null) ?? null,
      assinatura: null,
    }
    if (!this.asaas.configurado || !perfil.billingSubscriptionId) return base

    try {
      const sub = await this.asaas.obterAssinatura(perfil.billingSubscriptionId)
      if (!sub || sub.deleted) return base
      const cobrancas = await this.asaas.cobrancasDaAssinatura(sub.id)
      const pagas = cobrancas.filter((c) => PAGAS.has(c.status))
      const aberta = cobrancas.find((c) => EM_ABERTO.has(c.status)) ?? null
      const pix =
        aberta && sub.billingType === 'PIX' ? await this.asaas.pixQrCode(aberta.id).catch(() => null) : null
      const prazo = perfil.planStatus === 'canceled' ? null : prazoDeArrependimento(pagas, agora)

      return {
        ...base,
        assinatura: {
          meio: sub.billingType,
          valor: sub.value ?? PLAN_PRICE[(perfil.plan as 'pro' | 'premium')] ?? 0,
          proximaCobranca: sub.status === 'ACTIVE' ? sub.nextDueDate : null,
          cartao:
            sub.billingType === 'CREDIT_CARD'
              ? { final: sub.creditCard?.creditCardNumber, bandeira: sub.creditCard?.creditCardBrand }
              : undefined,
          emAberto: aberta
            ? {
                vencimento: aberta.dueDate,
                valor: aberta.value,
                vencida: aberta.status === 'OVERDUE',
                fatura: aberta.invoiceUrl,
                boleto: aberta.bankSlipUrl ?? undefined,
                pix: pix ? { imagem: pix.encodedImage, copiaECola: pix.payload } : undefined,
              }
            : null,
          arrependimentoAte: prazo ? prazo.toISOString() : null,
        },
      }
    } catch (e) {
      // A tela da assinatura não pode sumir porque o Asaas demorou: mostra o que
      // o nosso banco sabe (plano, status, datas) e esconde só o detalhe.
      this.log.warn(`resumo sem o Asaas: ${e instanceof AsaasErro ? e.codigo : 'erro'}`)
      return base
    }
  }

  // ---- Cancelar --------------------------------------------------------------

  async cancelar(userId: string, agora = new Date()): Promise<ResultadoDoCancelamento> {
    if (!this.asaas.configurado) {
      throw new ServiceUnavailableException('O pagamento on-line não está disponível agora. Tente de novo em instantes.')
    }
    const perfil = await this.perfilDe(userId)
    const id = perfil.billingSubscriptionId
    if (!id) throw new BadRequestException('Não há assinatura para cancelar.')

    // As cobranças são lidas ANTES de apagar: é delas que sai o direito de
    // arrependimento. Se o Asaas não responder, não se decide nada — mais vale
    // o advogado tentar de novo do que perder uma devolução a que tem direito.
    let pagas: CobrancaAsaas[] = []
    try {
      pagas = (await this.asaas.cobrancasDaAssinatura(id)).filter((c) => PAGAS.has(c.status))
    } catch (e) {
      this.falhaDoAsaas(e, 'Não foi possível cancelar agora. Nada mudou na sua assinatura; tente de novo em instantes.')
    }
    const prazo = perfil.plan === 'free' ? null : prazoDeArrependimento(pagas, agora)

    // 1. APAGAR PRIMEIRO. Se a devolução viesse antes e o cancelamento falhasse, o
    //    advogado teria o dinheiro de volta e a próxima cobrança marcada — o pior
    //    dos dois mundos. Apagada a assinatura, nada mais é cobrado, aconteça o que
    //    acontecer com a devolução.
    try {
      await this.asaas.cancelarAssinatura(id)
    } catch (e) {
      this.falhaDoAsaas(e, 'Não foi possível cancelar agora. Nada mudou na sua assinatura; tente de novo em instantes.')
    }

    // Plano nunca pago (Pix ou boleto em aberto): não há mês a respeitar nem
    // dinheiro a devolver. Some só o vínculo com a assinatura apagada.
    if (perfil.plan === 'free') {
      await this.prisma.profile.update({ where: { id: perfil.id }, data: { billingSubscriptionId: null } })
      return { ok: true, valeAte: null, devolucao: null, valorDevolvido: 0 }
    }

    // 2. DEVOLVER, se estiver no prazo.
    let devolucao: ResultadoDoCancelamento['devolucao'] = null
    const valor = pagas.reduce((t, c) => t + (c.value ?? 0), 0)
    if (prazo) {
      try {
        for (const c of pagas) {
          await this.asaas.estornar(c.id, 'Direito de arrependimento (CDC, art. 49): cancelamento em até 7 dias.')
        }
        devolucao = 'feita'
      } catch (e) {
        devolucao = 'pendente'
        this.log.error(`devolução automática falhou (${e instanceof AsaasErro ? e.codigo : 'erro'}) — chamado aberto`)
        await this.prisma.supportTicket
          .create({
            data: {
              userId,
              kind: 'conta',
              subject: 'Devolução do valor pago (arrependimento)',
              message:
                `Você cancelou a assinatura dentro do prazo de ${PRAZO_ARREPENDIMENTO_DIAS} dias, e tem direito à ` +
                `devolução integral de ${reais(valor)}. A devolução automática não pôde ser concluída agora; ` +
                'a equipe vai fazê-la manualmente e responder aqui. Nada mais será cobrado. ' +
                `[cobranças: ${pagas.map((c) => c.id).join(', ')}]`,
              pageUrl: '/assinatura',
              userAgent: 'sistema (cobrança)',
            },
          })
          .catch(() => this.log.error('e o chamado de devolução também falhou — conferir o log do Asaas'))
      }
    }

    // 3. O PLANO. Devolvido o dinheiro, o plano termina agora — não se devolve o
    //    valor e se mantém o mês. Sem devolução, quem pagou o mês tem o mês.
    const patch =
      devolucao === 'feita'
        ? { planStatus: 'canceled' as const, currentPeriodEnd: agora, graceUntil: null, planScheduled: null }
        : aoCancelar(perfil as any, agora)
    await this.profiles.aplicarAssinaturaPorPerfil(
      perfil.id,
      patch,
      devolucao === 'feita' ? 'cancelamento com arrependimento: valor devolvido' : 'cancelamento pedido pela pessoa',
    )
    return {
      ok: true,
      valeAte: devolucao === 'feita' || !patch.currentPeriodEnd ? null : patch.currentPeriodEnd.toISOString(),
      devolucao,
      valorDevolvido: devolucao ? valor : 0,
    }
  }

  // ---- Trocar de plano -------------------------------------------------------

  async trocarPlano(
    userId: string,
    bruto: unknown,
    remoteIp: string,
    agora = new Date(),
  ): Promise<ResumoDaAssinatura | ResultadoDoCancelamento> {
    if (!this.asaas.configurado) {
      throw new ServiceUnavailableException('O pagamento on-line não está disponível agora. Tente de novo em instantes.')
    }
    const b = (bruto && typeof bruto === 'object' ? bruto : {}) as Record<string, unknown>
    const alvo = b.plano === 'free' || b.plano === 'pro' || b.plano === 'premium' ? (b.plano as Plan) : null
    if (!alvo) throw new BadRequestException('Plano inválido.')
    if (alvo === 'free') return this.cancelar(userId, agora)

    const perfil = await this.perfilDe(userId)
    const id = perfil.billingSubscriptionId
    if (!id || perfil.planStatus === 'canceled') {
      throw new ConflictException('Não há assinatura ativa para trocar. Assine o plano que você quer.')
    }
    const atual = perfil.plan as Plan

    // Mesmo plano: a única coisa a fazer é desfazer uma descida agendada.
    if (alvo === atual && !perfil.planScheduled) return this.resumo(userId, agora)

    const sub = await this.asaas.obterAssinatura(id).catch((e) => this.falhaDoAsaas(e, 'Não foi possível trocar de plano agora.'))
    if (!sub || sub.deleted) throw new ConflictException('Não há assinatura ativa para trocar. Assine o plano que você quer.')

    const marca = marcaExterna(perfil.id, alvo)
    const descricao = `advoc.me ${PLAN_NAME[alvo]} (mensal)`
    try {
      await this.asaas.atualizarAssinatura(id, { valor: PLAN_PRICE[alvo], externalReference: marca, descricao })
    } catch (e) {
      const recusadaNoCartao = e instanceof AsaasErro && e.status === 400 && sub.billingType === 'CREDIT_CARD'
      if (!recusadaNoCartao) this.falhaDoAsaas(e, 'Não foi possível trocar de plano agora. Nada mudou; tente de novo.')
      // A conta não tem tokenização: a troca no cartão pede o cartão de novo e
      // nasce uma assinatura nova, cobrando no dia em que a antiga cobraria.
      if (!b.cartao) {
        throw new ConflictException({
          statusCode: 409,
          codigo: 'precisa_cartao',
          message: 'Para trocar de plano no cartão, confirme os dados do cartão.',
        })
      }
      const dados = limparCartao(b, { agora, exigirLuhn: this.asaas.ambiente !== 'sandbox' })
      try {
        const nova = await this.asaas.criarAssinatura({
          customer: perfil.billingCustomerId ?? '',
          meio: 'CREDIT_CARD',
          valor: PLAN_PRICE[alvo],
          vencimento: sub.nextDueDate,
          descricao,
          externalReference: marca,
          cartao: dados.cartao,
          titular: {
            ...dados.titular,
            nome: dados.cartao.nomeImpresso,
            email: perfil.user?.email ?? '',
            cpfCnpj: dados.cpfCnpj,
          },
          remoteIp,
        })
        await this.asaas.cancelarAssinatura(id)
        await this.prisma.profile.update({ where: { id: perfil.id }, data: { billingSubscriptionId: nova.id } })
      } catch (e2) {
        this.falhaDoAsaas(e2, 'Não foi possível trocar de plano agora. Nada mudou; tente de novo.')
      }
    }

    // O nosso lado: subir vale já; descer fica agendado; mesmo plano desfaz o agendamento.
    const patch = alvo === atual ? { planScheduled: null } : aoTrocarPlano(perfil as any, alvo, agora)
    await this.profiles.aplicarAssinaturaPorPerfil(
      perfil.id,
      patch,
      alvo === atual ? `troca de plano desfeita: segue no ${atual}` : `troca de plano no Asaas: ${atual} → ${alvo}`,
    )
    return this.resumo(userId, agora)
  }

  // ---- Trocar o cartão -------------------------------------------------------

  async trocarCartao(userId: string, bruto: unknown, remoteIp: string, agora = new Date()): Promise<ResumoDaAssinatura> {
    if (!this.asaas.configurado) {
      throw new ServiceUnavailableException('O pagamento on-line não está disponível agora. Tente de novo em instantes.')
    }
    const perfil = await this.perfilDe(userId)
    const id = perfil.billingSubscriptionId
    if (!id) throw new BadRequestException('Não há assinatura para trocar o cartão.')
    const sub = await this.asaas.obterAssinatura(id).catch((e) => this.falhaDoAsaas(e, 'Não foi possível trocar o cartão agora.'))
    if (!sub || sub.deleted) throw new BadRequestException('Não há assinatura para trocar o cartão.')
    if (sub.billingType !== 'CREDIT_CARD') throw new BadRequestException('Sua assinatura não é paga no cartão.')

    const dados = limparCartao(bruto, { agora, exigirLuhn: this.asaas.ambiente !== 'sandbox' })
    try {
      await this.asaas.trocarCartao(id, {
        cartao: dados.cartao,
        titular: {
          ...dados.titular,
          nome: dados.cartao.nomeImpresso,
          email: perfil.user?.email ?? '',
          cpfCnpj: dados.cpfCnpj,
        },
        remoteIp,
      })
    } catch (e) {
      this.falhaDoAsaas(e, 'Não foi possível trocar o cartão agora. O cartão anterior continua valendo.')
    }
    this.log.log(`cartão trocado no perfil ${perfil.id}`)
    return this.resumo(userId, agora)
  }
}
