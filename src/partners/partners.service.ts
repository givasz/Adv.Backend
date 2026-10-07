// PROGRAMA ADVOCME PARCEIROS — as regras de negócio, num lugar só.
//
// O que é recompensado, e NADA além disso:
//
//   parceiro advogado → indica o SOFTWARE a outro profissional → a pessoa cria
//   uma conta NOVA → paga PRO ou MAX → o Asaas confirma → passados 7 dias sem
//   estorno, o parceiro ganha 30 dias de MAX.
//
// Este arquivo não importa, não consulta e não conhece MeetingRequest, LinkEvent,
// CalendarEntry, Report, triagem ou contato de visitante. Uma recompensa ligada a
// cliente jurídico seria captação de clientela (CED, art. 7º) — e a garantia de
// que isso não acontece por acidente é o programa simplesmente não enxergar esses
// dados.
//
// TRÊS REGRAS DE ENGENHARIA
//
//  1. O benefício NUNCA toca em `Profile.plan` nem nas datas de cobrança. Ele é
//     lido por planoVigente() (src/assinatura.ts); o que muda no banco quando ele
//     começa ou acaba é só o que o público veria errado (tema, agenda, endereço),
//     pela porta ProfilesService.reconciliarPlanoEfetivo.
//  2. IDEMPOTÊNCIA PELO BANCO, não por leitura prévia. As chaves únicas —
//     PartnerReward.key, .referralId, .sourcePaymentId e
//     PartnerReferral.referredUserId — são o que resolve a corrida entre o
//     webhook e o checkout, e entre PAYMENT_CONFIRMED e PAYMENT_RECEIVED do mesmo
//     pagamento. P2002 aqui é "já foi feito", não erro.
//  3. `benefitUntil` só muda por COMPARE-AND-SWAP (ver comBeneficio): dentro de
//     uma transação, relê o prazo, calcula o novo e grava só se ele ainda for o
//     que foi lido. Duas indicações que amadurecem no mesmo segundo somam as duas.

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { ProfilesService } from '../profiles/profiles.service'
import { CorreioService } from '../mail/correio.service'
import { urlDoSite } from '../mail/config'
import { PLAN_PRICE } from '../plans'
import { faixaTrilha, trilha } from '../admin/paginacao'
import {
  beneficioParceiroAtivo,
  planoDaAssinatura,
  planoVigente,
  SELECT_PARCEIRO,
  somarDias,
  type Plan,
} from '../assinatura'
import type { RequisicaoComAuth } from '../auth/session-context'
import {
  codigoValido,
  gravarAtribuicao,
  novoCodigo,
  selarAtribuicao,
  temAtribuicaoValida,
} from './partner-attribution'
import {
  AVISO_DE_FIM_DIAS,
  AVISO_FIM_SEM_COBRANCA,
  AVISO_MAX_ATIVO,
  AVISO_MAX_ESCRITORIO,
  AVISO_OBRIGATORIO,
  AVISO_PRO,
  BENEFICIO_INICIAL_DIAS,
  CHAMADA_DO_PROGRAMA,
  NOME_DO_PROGRAMA,
  PARTNER_TERMS_VERSION,
  RECOMPENSA_DIAS,
  REGRAS_DO_PROGRAMA,
  REVISAO_JURIDICA_PENDENTE,
  VALIDACAO_DIAS,
} from './partner-terms'

export type StatusDoParceiro = 'invited' | 'active' | 'suspended' | 'ended'

/** Situação de uma indicação, como o PARCEIRO a vê — sem nada de quem foi indicado. */
export type SituacaoDaIndicacao = 'cadastro' | 'validacao' | 'confirmada' | 'revogada' | 'nao-elegivel'

export type ResultadoDaConversao = 'criada' | 'repetida' | 'sem-indicacao' | 'nao-elegivel' | 'ignorada'

const DIA_MS = 24 * 60 * 60 * 1000
const TENTATIVAS_DE_CAS = 6
const MOTIVO_MAX = 300
const AJUSTE_MAX_DIAS = 365

/** Outra transação mexeu no prazo entre a leitura e a escrita: refaz a conta. */
class CorridaDoBeneficio extends Error {}
/** Outra entrega do mesmo pagamento chegou antes: nada a fazer. */
class JaFeito extends Error {}

function chaveRepetida(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: unknown }).code === 'P2002'
}

function data(v: Date | string | null | undefined): Date | null {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

function iso(v: Date | string | null | undefined): string | null {
  return data(v)?.toISOString() ?? null
}

function mesmoInstante(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null)
}

function centavos(v: number): number {
  return Math.round(v * 100)
}

/** Soma dias a partir do que for MAIOR: hoje ou o prazo que já existe. */
export function prorrogar(atual: Date | null, dias: number, agora: Date): Date {
  const base = atual && atual.getTime() > agora.getTime() ? atual : agora
  return somarDias(base, dias)
}

/**
 * Tira dias ainda NÃO consumidos. Prazo vencido não muda (não há o que tirar), e
 * o resultado nunca fica antes de agora — um estorno não cria dívida de dias.
 */
export function descontar(atual: Date | null, dias: number, agora: Date): Date | null {
  if (!atual || atual.getTime() <= agora.getTime()) return atual
  const novo = somarDias(atual, -Math.abs(dias))
  return novo.getTime() > agora.getTime() ? novo : agora
}

/** Os últimos seis caracteres do id da indicação — é tudo que o parceiro vê dela. */
export function rotuloDaIndicacao(id: string): string {
  return `Indicação •••${id.slice(-6).toUpperCase()}`
}

function situacaoDe(r: {
  disqualifiedAt: Date | null
  reward: { status: string } | null
}): SituacaoDaIndicacao {
  if (r.reward?.status === 'confirmed') return 'confirmada'
  if (r.reward?.status === 'pending') return 'validacao'
  if (r.reward?.status === 'revoked') return 'revogada'
  if (r.disqualifiedAt) return 'nao-elegivel'
  return 'cadastro'
}

interface EstadoFinanceiro {
  plan: string
  planStatus: string
  currentPeriodEnd: Date | null
  graceUntil: Date | null
  planScheduled?: string | null
  firmMembership?: { status: string } | null
}

/**
 * Quem já paga o MAX com renovação ativa não ativa a cortesia. Somar 45 dias a
 * uma assinatura que segue renovando seria dar dias que nunca seriam usados — ou,
 * pior, sugerir que a cobrança parou. A pessoa cancela a renovação antes, pelo
 * fluxo de sempre, e aí os dias começam depois do período já pago.
 */
export function bloqueioDoMax(p: EstadoFinanceiro, agora = new Date()): string | null {
  if (p.plan !== 'premium' || p.planStatus === 'canceled') return null
  if (planoDaAssinatura(p, agora) !== 'premium') return null
  if (p.firmMembership?.status === 'active') return AVISO_MAX_ESCRITORIO
  return AVISO_MAX_ATIVO
}

/** De onde contam os 45 dias: do fim do MAX já pago e cancelado, ou de agora. */
export function inicioDoBeneficio(p: EstadoFinanceiro, agora = new Date()): Date {
  const fim = data(p.currentPeriodEnd)
  if (p.plan === 'premium' && p.planStatus === 'canceled' && fim && fim.getTime() > agora.getTime()) {
    return fim
  }
  return agora
}

type Tx = Prisma.TransactionClient

@Injectable()
export class PartnersService {
  private readonly log = new Logger('Parceiros')

  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: ProfilesService,
    // Opcional só para os testes; no app vem do CorreioModule.
    @Optional() private readonly correio?: CorreioService,
  ) {}

  // ---- Observabilidade, sem dado pessoal -------------------------------------

  /** Uma linha por acontecimento: o nome e ids internos. Nada de e-mail, nome ou pagamento. */
  private evento(nome: string, ids: Record<string, string | number>): void {
    const partes = Object.entries(ids).map(([k, v]) => `${k}=${v}`)
    this.log.log([nome, ...partes].join(' '))
  }

  // ---- O prazo do benefício (compare-and-swap) --------------------------------

  /**
   * Muda `benefitUntil` com segurança contra corrida.
   *
   * `passo` recebe a transação e o estado relido DENTRO dela, faz o que tem de
   * fazer (reivindicar a recompensa, criar o ajuste) e devolve o prazo novo. A
   * gravação só acontece se o prazo ainda for o que foi lido; senão a transação
   * inteira é desfeita e a conta é refeita do zero, com o valor que a outra
   * transação deixou. Funciona igual no Postgres e no SQLite — nenhuma trava em
   * memória, nenhum campo financeiro do perfil envolvido.
   */
  private async comBeneficio<T>(
    partnerId: string,
    agora: Date,
    passo: (
      tx: Tx,
      atual: { benefitUntil: Date | null; status: string; profileId: string },
    ) => Promise<{ novo?: Date | null; resultado: T }>,
  ): Promise<T> {
    for (let tentativa = 0; tentativa < TENTATIVAS_DE_CAS; tentativa++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const m = await tx.partnerMembership.findUnique({
            where: { id: partnerId },
            select: { benefitUntil: true, status: true, profileId: true },
          })
          if (!m) throw new NotFoundException('Participação não encontrada.')
          const atual = data(m.benefitUntil)
          const { novo, resultado } = await passo(tx, { benefitUntil: atual, status: m.status, profileId: m.profileId })
          if (novo !== undefined && !mesmoInstante(novo, atual)) {
            const gravou = await tx.partnerMembership.updateMany({
              where: { id: partnerId, benefitUntil: atual },
              data: {
                benefitUntil: novo,
                // Prazo no futuro: há benefício correndo, a varredura do fim volta
                // a valer para ele. Prazo encerrado aqui: quem chamou reconcilia já.
                benefitReconciledAt: novo && novo.getTime() > agora.getTime() ? null : agora,
              },
            })
            if (gravou.count !== 1) throw new CorridaDoBeneficio()
          }
          return resultado
        })
      } catch (e) {
        if (e instanceof CorridaDoBeneficio) continue
        throw e
      }
    }
    throw new ConflictException('O benefício está sendo atualizado agora. Tente de novo em instantes.')
  }

  /** O plano efetivo do perfil do parceiro, AGORA — o "antes" de uma reconciliação. */
  private async planoEfetivoDoParceiro(partnerId: string, agora: Date): Promise<{ profileId: string; plano: Plan } | null> {
    const m = await this.prisma.partnerMembership.findUnique({
      where: { id: partnerId },
      select: {
        profileId: true,
        profile: {
          select: { plan: true, planStatus: true, currentPeriodEnd: true, graceUntil: true, partner: SELECT_PARCEIRO },
        },
      },
    })
    if (!m?.profile) return null
    return { profileId: m.profileId, plano: planoVigente(m.profile as any, agora) }
  }

  private async reconciliar(antes: { profileId: string; plano: Plan } | null, motivo: string, agora: Date) {
    if (!antes) return
    try {
      await this.profiles.reconciliarPlanoEfetivo(antes.profileId, antes.plano, motivo, agora)
    } catch (e) {
      // A leitura (planoVigente) já entrega o plano certo; o que falhou aqui é só
      // a arrumação do banco, que a varredura refaz.
      this.log.warn(`reconciliação do perfil ${antes.profileId} falhou: ${e instanceof Error ? e.message : e}`)
    }
  }

  // ---- E-mail ---------------------------------------------------------------

  private async avisar(
    partnerId: string,
    modelo:
      | 'parceiro-convidado'
      | 'parceiro-ativado'
      | 'parceiro-conversao-pendente'
      | 'parceiro-beneficio-prorrogado'
      | 'parceiro-beneficio-expirando'
      | 'parceiro-suspenso'
      | 'parceiro-encerrado',
    chave: string,
    dados: Record<string, unknown> = {},
  ): Promise<void> {
    if (!this.correio) return
    try {
      const m = await this.prisma.partnerMembership.findUnique({
        where: { id: partnerId },
        select: { profile: { select: { userId: true, user: { select: { email: true } } } } },
      })
      const email = m?.profile?.user?.email
      if (!email) return
      await this.correio.enfileirar({ modelo, para: email, userId: m!.profile!.userId, dados, chave })
    } catch (e) {
      this.log.warn(`aviso ${modelo} não enfileirado: ${e instanceof Error ? e.message : e}`)
    }
  }

  // ---- Captura do link (rota pública) ----------------------------------------

  /**
   * POST /api/partners/attribution — grava o cookie assinado da indicação.
   *
   * Responde só `accepted: true/false`, e nunca diz de quem é o código. First-
   * touch: um navegador que já tem atribuição válida não troca de parceiro, e um
   * código inválido não apaga a atribuição que existia.
   */
  async capturarAtribuicao(req: RequisicaoComAuth, bruto: unknown): Promise<{ accepted: boolean }> {
    const codigo = codigoValido(bruto)
    if (!codigo) return { accepted: false }
    if (temAtribuicaoValida(req)) return { accepted: false }
    const m = await this.prisma.partnerMembership.findUnique({
      where: { referralCode: codigo },
      select: { id: true, status: true },
    })
    if (!m || m.status !== 'active') return { accepted: false }
    gravarAtribuicao(req, selarAtribuicao(m.id))
    return { accepted: true }
  }

  // ---- Convite (console) ----------------------------------------------------

  async convidar(userId: string, agora = new Date()) {
    const perfil = await this.prisma.profile.findUnique({
      where: { userId },
      select: { id: true, partner: { select: { id: true, status: true } } },
    })
    if (!perfil) throw new NotFoundException('Esta conta ainda não tem perfil.')
    if (perfil.partner) {
      throw new ConflictException(
        perfil.partner.status === 'ended'
          ? 'Esta participação foi encerrada, e o encerramento é definitivo.'
          : 'Esta conta já tem convite ou participação no programa.',
      )
    }
    for (let tentativa = 0; tentativa < 4; tentativa++) {
      try {
        const criado = await this.prisma.partnerMembership.create({
          data: { profileId: perfil.id, referralCode: novoCodigo(), status: 'invited', invitedAt: agora },
          select: { id: true, status: true },
        })
        this.evento('PARTNER_INVITED', { partner: criado.id })
        await this.avisar(criado.id, 'parceiro-convidado', `partner-invite:${criado.id}`)
        return { id: criado.id, status: criado.status as StatusDoParceiro }
      } catch (e) {
        if (!chaveRepetida(e)) throw e
        // Corrida no perfil (dois cliques) ou, raríssimo, código sorteado repetido.
        const ja = await this.prisma.partnerMembership.findUnique({ where: { profileId: perfil.id }, select: { id: true } })
        if (ja) throw new ConflictException('Esta conta já tem convite ou participação no programa.')
      }
    }
    throw new ConflictException('Não foi possível gerar um código agora. Tente de novo.')
  }

  // ---- O parceiro: painel, resumo, aceite --------------------------------------

  private async perfilDoParceiro(userId: string) {
    return this.prisma.profile.findUnique({
      where: { userId },
      select: {
        id: true,
        plan: true,
        planStatus: true,
        currentPeriodEnd: true,
        graceUntil: true,
        planScheduled: true,
        firmMembership: { select: { status: true } },
        partner: {
          select: {
            id: true,
            status: true,
            referralCode: true,
            benefitUntil: true,
            activatedAt: true,
            suspendedAt: true,
            endedAt: true,
            termsVersion: true,
            termsAcceptedAt: true,
          },
        },
      },
    })
  }

  /** O resumo leve que o painel usa para decidir se mostra o atalho do programa. */
  async resumo(userId: string, agora = new Date()) {
    const p = await this.prisma.profile.findUnique({
      where: { userId },
      select: { partner: SELECT_PARCEIRO },
    })
    const m = p?.partner
    if (!m) return { status: null, benefitUntil: null, activeBenefit: false }
    return {
      status: m.status as StatusDoParceiro,
      benefitUntil: iso(m.benefitUntil),
      activeBenefit: beneficioParceiroAtivo({ partner: m }, agora),
    }
  }

  /**
   * O painel do parceiro. Só da PRÓPRIA conta — o usuário vem da sessão, nunca de
   * um parâmetro. O que ele vê de cada indicação é situação, data e dias: nunca
   * nome, e-mail, OAB, cidade, IP, pagamento ou assinatura de quem se cadastrou.
   */
  async painel(userId: string, opcoes: { cursor?: string; limite?: unknown } = {}, agora = new Date()) {
    const p = await this.perfilDoParceiro(userId)
    const m = p?.partner
    if (!p || !m) throw new NotFoundException('Você não participa do Programa Advocme Parceiros.')
    const status = m.status as StatusDoParceiro
    const financeiro = planoDaAssinatura(p, agora)
    const ativo = beneficioParceiroAtivo({ partner: m }, agora)

    const base = {
      programa: NOME_DO_PROGRAMA,
      chamada: CHAMADA_DO_PROGRAMA,
      aviso: AVISO_OBRIGATORIO,
      revisaoJuridicaPendente: REVISAO_JURIDICA_PENDENTE,
      status,
      planoFinanceiro: financeiro,
      benefitUntil: iso(m.benefitUntil),
      activeBenefit: ativo,
      avisos: {
        pro: financeiro === 'pro' ? AVISO_PRO : null,
        fimSemCobranca: AVISO_FIM_SEM_COBRANCA,
      },
    }

    if (status === 'invited') {
      const bloqueio = bloqueioDoMax(p, agora)
      return {
        ...base,
        regras: { versao: PARTNER_TERMS_VERSION, itens: REGRAS_DO_PROGRAMA },
        beneficioInicialDias: BENEFICIO_INICIAL_DIAS,
        bloqueio,
        proximaAcao: bloqueio ?? `Leia as regras e aceite para ativar ${BENEFICIO_INICIAL_DIAS} dias de acesso ao MAX.`,
      }
    }

    const take = faixaTrilha(opcoes.limite, 20, 50)
    const cursor = typeof opcoes.cursor === 'string' && /^[a-z0-9]{8,40}$/i.test(opcoes.cursor) ? opcoes.cursor : undefined
    const [cadastrados, conversoes, pendentes, revogadas, linhas, beneficios] = await Promise.all([
      this.prisma.partnerReferral.count({ where: { partnerId: m.id } }),
      this.prisma.partnerReward.count({ where: { partnerId: m.id, type: 'referral', status: 'confirmed' } }),
      this.prisma.partnerReward.count({ where: { partnerId: m.id, type: 'referral', status: 'pending' } }),
      this.prisma.partnerReward.count({ where: { partnerId: m.id, type: 'referral', status: 'revoked' } }),
      this.prisma.partnerReferral.findMany({
        where: { partnerId: m.id },
        orderBy: [{ attributedAt: 'desc' }, { id: 'desc' }],
        take: take + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        // De propósito: NENHUM campo da conta indicada. Nem o id dela.
        select: {
          id: true,
          attributedAt: true,
          disqualifiedAt: true,
          reward: { select: { status: true, days: true, eligibleAt: true, confirmedAt: true } },
        },
      }),
      this.prisma.partnerReward.findMany({
        where: { partnerId: m.id, type: { in: ['initial', 'manual'] } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 20,
        select: { id: true, type: true, status: true, days: true, createdAt: true },
      }),
    ])
    const pagina = trilha(linhas, take)

    const proximaAcao =
      status === 'active'
        ? 'Compartilhe seu link com outros profissionais da advocacia. A nova conta precisa contratar PRO ou MAX.'
        : status === 'suspended'
          ? 'Sua participação está suspensa: o link não registra novas indicações e o acesso adicional ao MAX fica inativo. O prazo continua correndo. Fale com o suporte se tiver dúvidas.'
          : 'Sua participação foi encerrada. O histórico continua disponível aqui.'

    return {
      ...base,
      // O link existe para quem participa; encerrada, não há mais o que divulgar.
      referralUrl: status === 'ended' ? null : `${urlDoSite()}/r/${m.referralCode}`,
      totais: { cadastrados, conversoes, pendentes, revogadas },
      indicacoes: {
        itens: pagina.itens.map((r) => ({
          id: r.id,
          rotulo: rotuloDaIndicacao(r.id),
          data: iso(r.attributedAt),
          situacao: situacaoDe(r),
          dias: r.reward?.status === 'confirmed' ? r.reward.days : null,
          validaEm: r.reward?.status === 'pending' ? iso(r.reward.eligibleAt) : null,
        })),
        proximo: pagina.proximo,
        temMais: pagina.temMais,
      },
      beneficios: beneficios.map((b) => ({
        tipo: b.type as 'initial' | 'manual',
        situacao: b.status,
        dias: b.days,
        data: iso(b.createdAt),
      })),
      proximaAcao,
    }
  }

  /** POST /api/partners/accept — o aceite das regras e os 45 dias iniciais. */
  async aceitar(userId: string, ip: string, corpo: unknown, agora = new Date()) {
    const b = (corpo && typeof corpo === 'object' ? corpo : {}) as { accepted?: unknown; termsVersion?: unknown }
    if (b.accepted !== true) {
      throw new BadRequestException('Para participar, leia e aceite as regras do programa.')
    }
    // A versão vem do SERVIDOR. Se a tela mostrou outra, a pessoa leu um texto que
    // não é o que seria gravado — melhor recarregar do que aceitar o que não leu.
    if (b.termsVersion !== undefined && b.termsVersion !== PARTNER_TERMS_VERSION) {
      throw new ConflictException('As regras do programa foram atualizadas. Recarregue a página e leia a versão nova.')
    }

    const p = await this.perfilDoParceiro(userId)
    const m = p?.partner
    if (!p || !m) throw new NotFoundException('Você não tem convite para o Programa Advocme Parceiros.')
    if (m.status === 'active') return this.painel(userId, {}, agora) // dois cliques: nada em dobro
    if (m.status === 'suspended') throw new ConflictException('Sua participação no programa está suspensa.')
    if (m.status === 'ended') throw new ConflictException('Sua participação no programa foi encerrada.')

    const bloqueio = bloqueioDoMax(p, agora)
    if (bloqueio) throw new ConflictException(bloqueio)

    const antes = { profileId: p.id, plano: planoDaAssinatura(p, agora) }
    const ate = somarDias(inicioDoBeneficio(p, agora), BENEFICIO_INICIAL_DIAS)
    try {
      await this.prisma.$transaction(async (tx) => {
        // A recompensa inicial primeiro: a chave determinística é o que impede
        // dois aceites simultâneos de darem 90 dias.
        await tx.partnerReward.create({
          data: {
            partnerId: m.id,
            key: `initial:${m.id}`,
            type: 'initial',
            status: 'confirmed',
            days: BENEFICIO_INICIAL_DIAS,
            confirmedAt: agora,
            reason: 'aceite das regras do programa',
          },
        })
        const ativou = await tx.partnerMembership.updateMany({
          where: { id: m.id, status: 'invited' },
          data: {
            status: 'active',
            activatedAt: agora,
            termsVersion: PARTNER_TERMS_VERSION,
            termsAcceptedAt: agora,
            termsIp: ip.slice(0, 60),
            benefitUntil: ate,
            benefitReconciledAt: null,
          },
        })
        if (ativou.count !== 1) throw new JaFeito()
      })
    } catch (e) {
      if (chaveRepetida(e) || e instanceof JaFeito) return this.painel(userId, {}, agora)
      throw e
    }

    this.evento('PARTNER_ACTIVATED', { partner: m.id, dias: BENEFICIO_INICIAL_DIAS })
    this.evento('PARTNER_BENEFIT_EXTENDED', { partner: m.id, ate: ate.toISOString() })
    await this.reconciliar(antes, 'parceiros: acesso adicional ao Max ativado', agora)
    await this.avisar(m.id, 'parceiro-ativado', `partner-active:${m.id}`, { ate: ate.toISOString() })
    return this.painel(userId, {}, agora)
  }

  // ---- Conversão (chamada pela cobrança) ---------------------------------------

  /**
   * O primeiro pagamento REAL de uma conta indicada. Chamado pelos dois caminhos
   * que confirmam pagamento — o webhook (BillingService) e o cartão aprovado na
   * hora (CheckoutService) —, que podem chegar em qualquer ordem e repetidos.
   *
   * Quem chama já validou token, perfil, assinatura e ordem. Aqui se confere de
   * novo o que decide dinheiro: plano pago, valor exato e o id do PAGAMENTO
   * (nunca o do webhook: CONFIRMED e RECEIVED do mesmo pagamento têm ids de
   * evento diferentes). Nunca lança por "já feito".
   */
  async registrarConversao(
    d: {
      profileId: string
      plan?: string
      amount?: number
      paymentId?: string
      billingEventId?: string
      occurredAt?: Date | string
    },
    agora = new Date(),
  ): Promise<ResultadoDaConversao> {
    const paymentId = typeof d.paymentId === 'string' ? d.paymentId.trim().slice(0, 120) : ''
    if (!paymentId) return 'ignorada'
    if (d.plan !== 'pro' && d.plan !== 'premium') return 'ignorada'
    if (typeof d.amount !== 'number' || centavos(d.amount) !== centavos(PLAN_PRICE[d.plan])) return 'ignorada'

    const jaUsado = await this.prisma.partnerReward.findUnique({ where: { sourcePaymentId: paymentId }, select: { id: true } })
    if (jaUsado) return 'repetida'

    const perfil = await this.prisma.profile.findUnique({ where: { id: d.profileId }, select: { userId: true } })
    if (!perfil) return 'sem-indicacao'
    const ref = await this.prisma.partnerReferral.findUnique({
      where: { referredUserId: perfil.userId },
      select: {
        id: true,
        partnerId: true,
        convertedAt: true,
        reward: { select: { id: true } },
        partner: { select: { status: true, profile: { select: { userId: true } } } },
      },
    })
    // Conta sem indicação: o caminho de quase todo pagamento. Nada muda.
    if (!ref) return 'sem-indicacao'
    // Uma recompensa por indicação, e só no PRIMEIRO pagamento: renovação mensal,
    // troca de plano e o segundo aviso do mesmo pagamento caem aqui.
    if (ref.reward || ref.convertedAt) return 'repetida'

    const quando = data(d.occurredAt) ?? agora
    const motivoInelegivel =
      ref.partner.profile?.userId === perfil.userId
        ? 'autoindicação'
        : ref.partner.status !== 'active'
          ? 'participação do parceiro não estava ativa no pagamento'
          : null
    if (motivoInelegivel) {
      // A conversão aconteceu (é o primeiro pagamento), mas não gera nada — e,
      // marcada, impede que uma renovação depois da reativação gere.
      await this.prisma.partnerReferral.updateMany({
        where: { id: ref.id, convertedAt: null },
        data: { convertedAt: quando, disqualifiedAt: agora, disqualificationReason: motivoInelegivel },
      })
      this.evento('REFERRAL_CONVERTED', { referral: ref.id, elegivel: 'nao' })
      return 'nao-elegivel'
    }

    let rewardId: string
    try {
      rewardId = await this.prisma.$transaction(async (tx) => {
        const marcou = await tx.partnerReferral.updateMany({
          where: { id: ref.id, convertedAt: null },
          data: { convertedAt: quando },
        })
        if (marcou.count !== 1) throw new JaFeito()
        const r = await tx.partnerReward.create({
          data: {
            partnerId: ref.partnerId,
            referralId: ref.id,
            key: `referral:${ref.id}`,
            type: 'referral',
            status: 'pending',
            days: RECOMPENSA_DIAS,
            sourcePaymentId: paymentId,
            sourceBillingEventId: d.billingEventId?.slice(0, 120) ?? null,
            eligibleAt: somarDias(quando, VALIDACAO_DIAS),
            reason: `primeiro pagamento ${d.plan === 'premium' ? 'MAX' : 'PRO'} confirmado`,
          },
          select: { id: true, eligibleAt: true },
        })
        return r.id
      })
    } catch (e) {
      if (chaveRepetida(e) || e instanceof JaFeito) return 'repetida'
      throw e
    }

    this.evento('REFERRAL_CONVERTED', { referral: ref.id, elegivel: 'sim' })
    this.evento('PARTNER_REWARD_PENDING', { partner: ref.partnerId, reward: rewardId })
    await this.avisar(ref.partnerId, 'parceiro-conversao-pendente', `partner-pending:${rewardId}`, {
      validaEm: somarDias(quando, VALIDACAO_DIAS).toISOString(),
      dias: RECOMPENSA_DIAS,
    })
    return 'criada'
  }

  /** Estorno ou chargeback de um pagamento: a recompensa que ele gerou cai. */
  async revogarPorPagamento(paymentId: string | undefined, motivo: string, agora = new Date()) {
    const id = typeof paymentId === 'string' ? paymentId.trim().slice(0, 120) : ''
    if (!id) return 'sem-recompensa' as const
    const r = await this.prisma.partnerReward.findUnique({ where: { sourcePaymentId: id }, select: { id: true } })
    if (!r) return 'sem-recompensa' as const
    return this.revogarRecompensa(r.id, motivo, agora)
  }

  /**
   * Revoga uma recompensa de indicação. Pendente: só muda de situação. Confirmada:
   * muda de situação E devolve os 30 dias que ainda não foram usados, uma vez só —
   * a troca de situação e o desconto acontecem na mesma transação, e a segunda
   * chamada encontra a recompensa já revogada.
   */
  async revogarRecompensa(rewardId: string, motivo: string, agora = new Date()) {
    const razao = motivo.slice(0, MOTIVO_MAX)
    for (let volta = 0; volta < 3; volta++) {
      const rw = await this.prisma.partnerReward.findUnique({
        where: { id: rewardId },
        select: { id: true, partnerId: true, status: true, days: true, type: true },
      })
      if (!rw) throw new NotFoundException('Recompensa não encontrada.')
      if (rw.status === 'revoked') return 'repetida' as const
      if (rw.type !== 'referral') throw new BadRequestException('Só recompensas de indicação são revogadas; para o resto, use o ajuste.')

      if (rw.status === 'pending') {
        const r = await this.prisma.partnerReward.updateMany({
          where: { id: rw.id, status: 'pending' },
          data: { status: 'revoked', revokedAt: agora, reason: razao },
        })
        if (r.count === 1) {
          this.evento('PARTNER_REWARD_REVOKED', { reward: rw.id, de: 'pending' })
          return 'revogada' as const
        }
        continue // confirmada no meio do caminho: a próxima volta desconta
      }

      const antes = await this.planoEfetivoDoParceiro(rw.partnerId, agora)
      const resultado = await this.comBeneficio(rw.partnerId, agora, async (tx, m) => {
        const r = await tx.partnerReward.updateMany({
          where: { id: rw.id, status: 'confirmed' },
          data: { status: 'revoked', revokedAt: agora, reason: razao },
        })
        if (r.count !== 1) return { resultado: 'repetida' as const }
        return { novo: descontar(m.benefitUntil, rw.days, agora), resultado: 'revogada' as const }
      })
      if (resultado === 'revogada') {
        this.evento('PARTNER_REWARD_REVOKED', { reward: rw.id, de: 'confirmed', dias: rw.days })
        await this.reconciliar(antes, 'parceiros: recompensa revogada (estorno ou contestação)', agora)
      }
      return resultado
    }
    return 'repetida' as const
  }

  // ---- Amadurecimento (chamado pela varredura) ---------------------------------

  /** Confirma uma recompensa cuja validação de 7 dias terminou. */
  async confirmarRecompensa(rewardId: string, agora = new Date()) {
    const rw = await this.prisma.partnerReward.findUnique({
      where: { id: rewardId },
      select: { id: true, partnerId: true, status: true, days: true, eligibleAt: true, partner: { select: { status: true } } },
    })
    if (!rw || rw.status !== 'pending') return 'ignorada' as const
    if (!rw.eligibleAt || rw.eligibleAt.getTime() > agora.getTime()) return 'cedo' as const
    if (rw.partner.status === 'ended') {
      await this.revogarRecompensa(rw.id, 'participação encerrada antes da confirmação', agora)
      return 'revogada' as const
    }
    // Suspensa: a recompensa espera. Volta a valer se a participação for reativada.
    if (rw.partner.status !== 'active') return 'aguardando' as const

    const antes = await this.planoEfetivoDoParceiro(rw.partnerId, agora)
    let ate: Date | null = null
    const resultado = await this.comBeneficio(rw.partnerId, agora, async (tx, m) => {
      const r = await tx.partnerReward.updateMany({
        where: { id: rw.id, status: 'pending' },
        data: { status: 'confirmed', confirmedAt: agora },
      })
      if (r.count !== 1) return { resultado: 'repetida' as const }
      ate = prorrogar(m.benefitUntil, rw.days, agora)
      return { novo: ate, resultado: 'confirmada' as const }
    })
    if (resultado !== 'confirmada' || !ate) return resultado
    const ateIso = (ate as Date).toISOString()
    this.evento('PARTNER_REWARD_CONFIRMED', { partner: rw.partnerId, reward: rw.id, dias: rw.days })
    this.evento('PARTNER_BENEFIT_EXTENDED', { partner: rw.partnerId, ate: ateIso })
    await this.reconciliar(antes, 'parceiros: acesso adicional ao Max prorrogado', agora)
    await this.avisar(rw.partnerId, 'parceiro-beneficio-prorrogado', `partner-confirmed:${rw.id}`, {
      dias: rw.days,
      ate: ateIso,
    })
    return resultado
  }

  /** Recompensas maduras de participações ativas, em lote limitado. */
  async confirmarPendentes(agora = new Date(), lote = 200): Promise<number> {
    const maduras = await this.prisma.partnerReward.findMany({
      where: { status: 'pending', eligibleAt: { lte: agora }, partner: { status: 'active' } },
      orderBy: [{ eligibleAt: 'asc' }, { id: 'asc' }],
      take: lote,
      select: { id: true },
    })
    let confirmadas = 0
    for (const r of maduras) {
      try {
        if ((await this.confirmarRecompensa(r.id, agora)) === 'confirmada') confirmadas++
      } catch (e) {
        this.log.warn(`recompensa ${r.id}: ${e instanceof Error ? e.message : e}`)
      }
    }
    return confirmadas
  }

  /** Pendentes de participações encerradas não amadurecem: são revogadas. */
  async revogarDeEncerrados(agora = new Date(), lote = 200): Promise<number> {
    const alvos = await this.prisma.partnerReward.findMany({
      where: { status: 'pending', partner: { status: 'ended' } },
      take: lote,
      select: { id: true },
    })
    if (!alvos.length) return 0
    const r = await this.prisma.partnerReward.updateMany({
      where: { id: { in: alvos.map((a) => a.id) }, status: 'pending' },
      data: { status: 'revoked', revokedAt: agora, reason: 'participação encerrada antes da confirmação' },
    })
    if (r.count > 0) this.evento('PARTNER_REWARD_REVOKED', { quantidade: r.count, de: 'pending', motivo: 'encerrada' })
    return r.count
  }

  /**
   * Fim do benefício: o perfil é reconciliado UMA vez (tema, agenda, prazo do
   * endereço). A leitura já tinha fechado os recursos no segundo do vencimento —
   * isto só arruma o banco. `benefitReconciledAt` impede a segunda passagem.
   */
  async reconciliarVencidos(agora = new Date(), lote = 200): Promise<number> {
    const vencidos = await this.prisma.partnerMembership.findMany({
      where: { status: 'active', benefitReconciledAt: null, benefitUntil: { not: null, lte: agora } },
      orderBy: [{ benefitUntil: 'asc' }, { id: 'asc' }],
      take: lote,
      select: { id: true, profileId: true, benefitUntil: true },
    })
    let feitos = 0
    for (const m of vencidos) {
      try {
        // Antes do vencimento o benefício entregava o Max.
        await this.profiles.reconciliarPlanoEfetivo(m.profileId, 'premium', 'parceiros: fim do acesso adicional ao Max', agora)
        const marcou = await this.prisma.partnerMembership.updateMany({
          where: { id: m.id, benefitReconciledAt: null, benefitUntil: m.benefitUntil },
          data: { benefitReconciledAt: agora },
        })
        if (marcou.count === 1) {
          feitos++
          this.evento('PARTNER_BENEFIT_EXPIRED', { partner: m.id })
        }
      } catch (e) {
        this.log.warn(`fim do benefício ${m.id}: ${e instanceof Error ? e.message : e}`)
      }
    }
    return feitos
  }

  /** Aviso de que o benefício acaba em até 7 dias — um por prazo (a chave do correio garante). */
  async avisarExpirando(agora = new Date(), lote = 200): Promise<number> {
    const limite = new Date(agora.getTime() + AVISO_DE_FIM_DIAS * DIA_MS)
    let cursor: string | undefined
    let avisados = 0
    // Páginas por cursor, com teto: ninguém fica sem aviso por estar além do
    // primeiro lote, e uma base enorme não vira uma passada infinita.
    for (let pagina = 0; pagina < 10; pagina++) {
      const proximos = await this.prisma.partnerMembership.findMany({
        where: { status: 'active', benefitUntil: { gt: agora, lte: limite } },
        orderBy: { id: 'asc' },
        take: lote,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, benefitUntil: true },
      })
      for (const m of proximos) {
        const ate = iso(m.benefitUntil)!
        await this.avisar(m.id, 'parceiro-beneficio-expirando', `partner-expiring:${m.id}:${ate}`, { ate })
        avisados++
      }
      if (proximos.length < lote) break
      cursor = proximos[proximos.length - 1]!.id
    }
    return avisados
  }

  // ---- Console --------------------------------------------------------------

  private async exigirParticipacao(id: string) {
    const m = await this.prisma.partnerMembership.findUnique({
      where: { id },
      select: { id: true, status: true, benefitUntil: true, profileId: true, suspendedAt: true },
    })
    if (!m) throw new NotFoundException('Participação não encontrada.')
    return m
  }

  private retrato(m: { status: string; benefitUntil: Date | null }) {
    return { status: m.status, benefitUntil: iso(m.benefitUntil) }
  }

  async suspender(id: string, motivo: string, agora = new Date()) {
    const m = await this.exigirParticipacao(id)
    if (m.status !== 'active') throw new BadRequestException('Só uma participação ativa pode ser suspensa.')
    const antes = await this.planoEfetivoDoParceiro(id, agora)
    const r = await this.prisma.partnerMembership.updateMany({
      where: { id, status: 'active' },
      data: { status: 'suspended', suspendedAt: agora },
    })
    if (r.count !== 1) throw new ConflictException('A participação mudou enquanto isso. Recarregue a ficha.')
    this.evento('PARTNER_SUSPENDED', { partner: id })
    await this.reconciliar(antes, 'parceiros: participação suspensa', agora)
    await this.avisar(id, 'parceiro-suspenso', `partner-suspended:${id}:${agora.toISOString()}`, { motivo })
    return { antes: this.retrato(m), depois: { status: 'suspended', benefitUntil: iso(m.benefitUntil) } }
  }

  /** Reativar devolve só o prazo que ainda restar: a suspensão não pausou o relógio. */
  async reativar(id: string, agora = new Date()) {
    const m = await this.exigirParticipacao(id)
    if (m.status !== 'suspended') throw new BadRequestException('Só uma participação suspensa pode ser reativada.')
    const antes = await this.planoEfetivoDoParceiro(id, agora)
    const vencido = !m.benefitUntil || m.benefitUntil.getTime() <= agora.getTime()
    const r = await this.prisma.partnerMembership.updateMany({
      where: { id, status: 'suspended' },
      data: { status: 'active', suspendedAt: null, benefitReconciledAt: vencido ? agora : null },
    })
    if (r.count !== 1) throw new ConflictException('A participação mudou enquanto isso. Recarregue a ficha.')
    this.evento('PARTNER_REACTIVATED', { partner: id })
    await this.reconciliar(antes, 'parceiros: participação reativada', agora)
    return { antes: this.retrato(m), depois: { status: 'active', benefitUntil: iso(m.benefitUntil) } }
  }

  /** Definitivo. O histórico fica; o código deixa de valer e o benefício para. */
  async encerrar(id: string, motivo: string, agora = new Date()) {
    const m = await this.exigirParticipacao(id)
    if (m.status === 'ended') throw new BadRequestException('Esta participação já foi encerrada.')
    const antes = await this.planoEfetivoDoParceiro(id, agora)
    const r = await this.prisma.partnerMembership.updateMany({
      where: { id, status: { in: ['invited', 'active', 'suspended'] } },
      data: { status: 'ended', endedAt: agora },
    })
    if (r.count !== 1) throw new ConflictException('A participação mudou enquanto isso. Recarregue a ficha.')
    const revogadas = await this.prisma.partnerReward.updateMany({
      where: { partnerId: id, status: 'pending' },
      data: { status: 'revoked', revokedAt: agora, reason: 'participação encerrada antes da confirmação' },
    })
    this.evento('PARTNER_ENDED', { partner: id, pendentesRevogadas: revogadas.count })
    await this.reconciliar(antes, 'parceiros: participação encerrada', agora)
    await this.avisar(id, 'parceiro-encerrado', `partner-ended:${id}`, { motivo })
    return { antes: this.retrato(m), depois: { status: 'ended', benefitUntil: iso(m.benefitUntil), pendentesRevogadas: revogadas.count } }
  }

  /** Ajuste manual de dias (positivo ou negativo), sempre com recompensa `manual` no livro. */
  async ajustar(id: string, diasBrutos: unknown, motivo: string, agora = new Date()) {
    const dias = Number(diasBrutos)
    if (!Number.isInteger(dias) || dias === 0 || Math.abs(dias) > AJUSTE_MAX_DIAS) {
      throw new BadRequestException(`Informe um número inteiro de dias entre -${AJUSTE_MAX_DIAS} e ${AJUSTE_MAX_DIAS}, diferente de zero.`)
    }
    const m = await this.exigirParticipacao(id)
    if (m.status !== 'active' && m.status !== 'suspended') {
      throw new BadRequestException('Só é possível ajustar o benefício de uma participação ativa ou suspensa.')
    }
    const antes = await this.planoEfetivoDoParceiro(id, agora)
    const key = `manual:${randomUUID()}`
    const novo = await this.comBeneficio(id, agora, async (tx, atual) => {
      await tx.partnerReward.create({
        data: {
          partnerId: id,
          key,
          type: 'manual',
          status: 'confirmed',
          days: dias,
          confirmedAt: agora,
          reason: motivo.slice(0, MOTIVO_MAX),
        },
      })
      const ate = dias > 0 ? prorrogar(atual.benefitUntil, dias, agora) : descontar(atual.benefitUntil, dias, agora)
      return { novo: ate, resultado: ate }
    })
    this.evento('PARTNER_BENEFIT_EXTENDED', { partner: id, ajuste: dias })
    await this.reconciliar(antes, `parceiros: ajuste manual de ${dias} dia(s)`, agora)
    return { antes: this.retrato(m), depois: { status: m.status, benefitUntil: iso(novo), ajuste: dias } }
  }

  /**
   * Corrige o parceiro de uma indicação — só ANTES de existir conversão ou
   * recompensa, para um parceiro ativo, e nunca para a própria conta indicada.
   */
  async reatribuir(referralId: string, novoPartnerId: unknown) {
    const destino = typeof novoPartnerId === 'string' ? novoPartnerId.trim() : ''
    if (!destino) throw new BadRequestException('Informe a participação de destino.')
    const ref = await this.prisma.partnerReferral.findUnique({
      where: { id: referralId },
      select: { id: true, partnerId: true, referredUserId: true, convertedAt: true, reward: { select: { id: true } } },
    })
    if (!ref) throw new NotFoundException('Indicação não encontrada.')
    if (ref.convertedAt || ref.reward) {
      throw new BadRequestException('Esta indicação já converteu: o parceiro não pode mais ser trocado.')
    }
    if (ref.partnerId === destino) throw new BadRequestException('A indicação já é desta participação.')
    const alvo = await this.prisma.partnerMembership.findUnique({
      where: { id: destino },
      select: { id: true, status: true, profile: { select: { userId: true } } },
    })
    if (!alvo || alvo.status !== 'active') throw new BadRequestException('A participação de destino precisa estar ativa.')
    if (!ref.referredUserId) throw new BadRequestException('A conta indicada não existe mais.')
    if (alvo.profile?.userId === ref.referredUserId) {
      throw new BadRequestException('Um parceiro não pode ser indicado por si mesmo.')
    }
    // Laço: o destino foi, ele próprio, indicado pela conta desta indicação.
    const doIndicado = await this.prisma.partnerMembership.findFirst({
      where: { profile: { userId: ref.referredUserId } },
      select: { id: true },
    })
    if (doIndicado && alvo.profile?.userId) {
      const laco = await this.prisma.partnerReferral.findFirst({
        where: { partnerId: doIndicado.id, referredUserId: alvo.profile.userId },
        select: { id: true },
      })
      if (laco) throw new BadRequestException('A troca criaria um laço de indicações entre as duas contas.')
    }
    const r = await this.prisma.partnerReferral.updateMany({
      where: { id: ref.id, partnerId: ref.partnerId, convertedAt: null },
      data: { partnerId: alvo.id },
    })
    if (r.count !== 1) throw new ConflictException('A indicação mudou enquanto isso. Recarregue a ficha.')
    // A conversão pode ter acontecido no instante da troca: confere de novo.
    const recompensa = await this.prisma.partnerReward.findUnique({ where: { referralId: ref.id }, select: { id: true } })
    if (recompensa) {
      await this.prisma.partnerReferral.updateMany({ where: { id: ref.id }, data: { partnerId: ref.partnerId } })
      throw new ConflictException('A indicação converteu durante a troca; nada foi alterado.')
    }
    this.evento('REFERRAL_ATTRIBUTED', { referral: ref.id, corrigida: 'sim' })
    return { antes: { partnerId: ref.partnerId }, depois: { partnerId: alvo.id } }
  }

  /** Lista do console, por cursor, com filtro por situação e busca. */
  async listarParaConsole(filtros: { status?: string; q?: string; cursor?: string; limite?: unknown }) {
    const take = faixaTrilha(filtros.limite, 25, 100)
    const status = ['invited', 'active', 'suspended', 'ended'].includes(filtros.status ?? '') ? filtros.status : undefined
    const q = (filtros.q ?? '').trim().slice(0, 80)
    const linhas = await this.prisma.partnerMembership.findMany({
      where: {
        ...(status ? { status: status as StatusDoParceiro } : {}),
        ...(q
          ? {
              OR: [
                { referralCode: q },
                { profile: { name: { contains: q } } },
                { profile: { slug: { contains: q } } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(filtros.cursor ? { cursor: { id: filtros.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        status: true,
        referralCode: true,
        benefitUntil: true,
        invitedAt: true,
        activatedAt: true,
        suspendedAt: true,
        endedAt: true,
        profile: { select: { name: true, slug: true, userId: true } },
        _count: {
          select: {
            referrals: true,
            rewards: { where: { type: 'referral', status: 'confirmed' } },
          },
        },
      },
    })
    const pagina = trilha(linhas, take)
    return {
      ...pagina,
      itens: pagina.itens.map((m) => ({
        id: m.id,
        status: m.status,
        codigo: m.referralCode,
        nome: m.profile?.name ?? '',
        slug: m.profile?.slug ?? '',
        userId: m.profile?.userId ?? '',
        benefitUntil: iso(m.benefitUntil),
        invitedAt: iso(m.invitedAt),
        activatedAt: iso(m.activatedAt),
        suspendedAt: iso(m.suspendedAt),
        endedAt: iso(m.endedAt),
        cadastrados: m._count.referrals,
        conversoes: m._count.rewards,
      })),
    }
  }

  /**
   * Ficha do console. Mostra o que é preciso para decidir — inclusive quem foi
   * indicado (o console já enxerga contas) —, mas o id do pagamento vai mascarado:
   * para casar com o Asaas bastam os últimos caracteres.
   */
  async fichaParaConsole(id: string, opcoes: { cursor?: string } = {}, agora = new Date()) {
    const m = await this.prisma.partnerMembership.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        referralCode: true,
        benefitUntil: true,
        termsVersion: true,
        termsAcceptedAt: true,
        invitedAt: true,
        activatedAt: true,
        suspendedAt: true,
        endedAt: true,
        benefitReconciledAt: true,
        profile: {
          select: {
            id: true,
            userId: true,
            name: true,
            slug: true,
            oabNumber: true,
            plan: true,
            planStatus: true,
            currentPeriodEnd: true,
            graceUntil: true,
            partner: SELECT_PARCEIRO,
          },
        },
      },
    })
    if (!m) throw new NotFoundException('Participação não encontrada.')
    const take = 25
    const cursor = typeof opcoes.cursor === 'string' && /^[a-z0-9]{8,40}$/i.test(opcoes.cursor) ? opcoes.cursor : undefined
    const [indicacoes, recompensas] = await Promise.all([
      this.prisma.partnerReferral.findMany({
        where: { partnerId: id },
        orderBy: [{ attributedAt: 'desc' }, { id: 'desc' }],
        take: take + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          attributedAt: true,
          convertedAt: true,
          disqualifiedAt: true,
          disqualificationReason: true,
          referredUserId: true,
          referredUser: { select: { profile: { select: { name: true, slug: true, oabNumber: true } } } },
          reward: { select: { id: true, status: true } },
        },
      }),
      this.prisma.partnerReward.findMany({
        where: { partnerId: id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 50,
        select: {
          id: true,
          type: true,
          status: true,
          days: true,
          referralId: true,
          sourcePaymentId: true,
          eligibleAt: true,
          confirmedAt: true,
          revokedAt: true,
          reason: true,
          createdAt: true,
        },
      }),
    ])
    // O histórico relevante: a participação, e as indicações e recompensas dela
    // que o console já corrigiu ou revogou.
    const historico = await this.prisma.adminAction.findMany({
      where: { targetId: { in: [id, ...indicacoes.map((r) => r.id), ...recompensas.map((r) => r.id)] } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    })
    const pagina = trilha(indicacoes, take)
    const oabDoParceiro = normalizarOab(m.profile?.oabNumber)
    const perfil = m.profile
    return {
      id: m.id,
      status: m.status,
      codigo: m.referralCode,
      benefitUntil: iso(m.benefitUntil),
      beneficioAtivo: beneficioParceiroAtivo({ partner: m }, agora),
      termsVersion: m.termsVersion,
      termsAcceptedAt: iso(m.termsAcceptedAt),
      invitedAt: iso(m.invitedAt),
      activatedAt: iso(m.activatedAt),
      suspendedAt: iso(m.suspendedAt),
      endedAt: iso(m.endedAt),
      benefitReconciledAt: iso(m.benefitReconciledAt),
      conta: perfil
        ? {
            userId: perfil.userId,
            profileId: perfil.id,
            nome: perfil.name,
            slug: perfil.slug,
            planoContratado: perfil.plan,
            planoFinanceiro: planoDaAssinatura(perfil as any, agora),
            planoEfetivo: planoVigente(perfil as any, agora),
            situacaoCobranca: perfil.planStatus,
            fimDoPeriodo: iso(perfil.currentPeriodEnd),
          }
        : null,
      indicacoes: {
        itens: pagina.itens.map((r) => {
          const indicado = r.referredUser?.profile
          return {
            id: r.id,
            attributedAt: iso(r.attributedAt),
            convertedAt: iso(r.convertedAt),
            disqualifiedAt: iso(r.disqualifiedAt),
            disqualificationReason: r.disqualificationReason,
            referredUserId: r.referredUserId,
            indicado: indicado ? { nome: indicado.name, slug: indicado.slug } : null,
            // OAB é autodeclarada e não é conferida: igual não prova fraude, só
            // pede um olhar humano. Nunca bloqueia nada sozinha.
            revisarOab: !!oabDoParceiro && normalizarOab(indicado?.oabNumber) === oabDoParceiro,
            recompensa: r.reward ? { id: r.reward.id, status: r.reward.status } : null,
          }
        }),
        proximo: pagina.proximo,
        temMais: pagina.temMais,
      },
      recompensas: recompensas.map((r) => ({
        ...r,
        sourcePaymentId: r.sourcePaymentId ? `•••${r.sourcePaymentId.slice(-6)}` : null,
        eligibleAt: iso(r.eligibleAt),
        confirmedAt: iso(r.confirmedAt),
        revokedAt: iso(r.revokedAt),
        createdAt: iso(r.createdAt),
      })),
      historico,
    }
  }
}

/** OAB para comparação: só letras e dígitos, maiúsculas. Vazio quando não há número. */
export function normalizarOab(v: string | null | undefined): string {
  const s = (v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return /\d{3,}/.test(s) ? s : ''
}
