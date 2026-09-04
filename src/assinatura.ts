// Estado da assinatura — FONTE DA VERDADE de "o que esta pessoa tem direito a usar
// AGORA". O front espelha o essencial em frontend/src/lib/assinatura.ts.
//
// POR QUE ISTO EXISTE
//
// Até aqui o direito de uso era um enum de três valores em `Profile.plan`, e nada
// mais. Um enum não sabe dizer "assinou, o cartão falhou na terça, e o provedor
// ainda vai tentar de novo por duas semanas" — então a única coisa implementável
// no dia em que a cobrança real entrasse seria rebaixar no primeiro erro de
// cartão. Que é o pior comportamento possível: a esmagadora maioria das falhas de
// cobrança recorrente é cartão vencido ou limite momentâneo, não desistência.
// Derrubar o perfil público de um advogado por causa disso é dano — e dano que
// chega antes do e-mail que avisa.
//
// O QUE SEPARA UM ESTADO DO OUTRO
//
//   active    → em dia. Acesso pleno.
//   past_due  → a cobrança falhou. Acesso PLENO até `graceUntil`. É o estado em
//               que o provedor ainda tenta e em que nós avisamos.
//   canceled  → a assinatura acabou (pedido da pessoa ou fim das tentativas).
//               Acesso pleno até `currentPeriodEnd` — quem pagou o mês tem o mês.
//   paused    → sanção de moderação suspendeu a COBRANÇA (CDC art. 51, IV: serviço
//               indisponível não se cobra). O acesso não é retirado aqui; quem o
//               restringe é a moderação, por outra porta. Confundir as duas coisas
//               faria a sanção virar um rebaixamento disfarçado, sem prazo e sem
//               contestação — exatamente o que docs/politica-de-sancoes.md proíbe.
//
// A REGRA DE OURO: nada neste arquivo APAGA nada. O plano vigente é uma leitura,
// derivada de datas. Um webhook fora de ordem, um relógio adiantado ou um provedor
// que repete o mesmo evento três vezes não podem custar conteúdo a ninguém — por
// isso o rebaixamento é sempre "esconder", nunca "excluir".

export type Plan = 'free' | 'pro' | 'premium'

export type PlanStatus = 'active' | 'past_due' | 'canceled' | 'paused'

export const PLAN_STATUSES: PlanStatus[] = ['active', 'past_due', 'canceled', 'paused']

/**
 * Carência depois que o provedor desiste de cobrar.
 *
 * Não é generosidade: é o intervalo entre "o cartão falhou" e "a pessoa soube que
 * o cartão falhou". E-mail de cobrança cai em spam, advogado em audiência não abre
 * o painel, cartão novo demora a chegar. Sete dias cobrem uma semana útil inteira
 * — e o custo de errar para o lado curto (perfil fora do ar, cartão de visita
 * impresso apontando para lugar nenhum) é muito maior que o de errar para o lado
 * longo (uma semana de Pro não paga).
 */
export const CARENCIA_DIAS = 7

/**
 * Tolerância no vencimento do período pago.
 *
 * O webhook de renovação não chega no milissegundo em que o período vira: há fila
 * no provedor, retentativa, e a nossa própria janela de indisponibilidade. Sem
 * tolerância, um atraso de vinte minutos na confirmação rebaixaria alguém que
 * PAGOU. Três dias é folga bastante para qualquer atraso de webhook e curto o
 * suficiente para não virar mês grátis.
 */
export const TOLERANCIA_RENOVACAO_DIAS = 3

/**
 * Prazo do ENDEREÇO depois que o plano cai para o Free.
 *
 * O endereço sem número é o perk mais visível do Pro. Devolvê-lo ao padrão do
 * Free é o que faz o rebaixamento ter peso — sem isso, a única diferença que a
 * pessoa nota é o que sumiu da página, e o endereço vira um perk pago que
 * ninguém devolve.
 *
 * Mas tirar no mesmo instante seria emboscada: o endereço está impresso em cartão
 * de visita, colado num QR e indexado no Google. Então ele não cai junto com o
 * plano — ele ganha prazo, com a data escrita no painel desde o primeiro dia, e
 * só vira número no fim dele. Somado à carência de cobrança, quem tem o cartão
 * recusado tem duas semanas até o link mudar.
 *
 * Sete dias, e não trinta: um prazo longo demais deixa de ser aviso e vira outro
 * mês de perk pago de graça.
 */
export const CARENCIA_ENDERECO_DIAS = 7

const RANK: Record<Plan, number> = { free: 0, pro: 1, premium: 2 }

const DIA_MS = 24 * 60 * 60 * 1000

/** Linha de perfil (ou qualquer objeto) com o suficiente para decidir o acesso. */
export interface EstadoAssinatura {
  plan?: string | null
  planStatus?: string | null
  /** fim do período JÁ PAGO */
  currentPeriodEnd?: Date | string | null
  /** fim da carência aberta por falha de pagamento */
  graceUntil?: Date | string | null
  /** rebaixamento pedido e agendado para o fim do período pago */
  planScheduled?: string | null
  /** até quando o endereço limpo ainda é desta pessoa depois de cair para o Free */
  slugGraceUntil?: Date | string | null
}

/** Data tolerante a string (o mock do front e o JSON do webhook mandam string). */
function data(v: Date | string | null | undefined): Date | null {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

function planoDe(v: unknown): Plan {
  return v === 'pro' || v === 'premium' ? v : 'free'
}

function statusDe(v: unknown): PlanStatus {
  return PLAN_STATUSES.includes(v as PlanStatus) ? (v as PlanStatus) : 'active'
}

export function somarDias(base: Date, dias: number): Date {
  return new Date(base.getTime() + dias * DIA_MS)
}

/** a >= b em ranking de plano (free < pro < premium). */
export function planoAoMenos(plano: unknown, minimo: Plan): boolean {
  return RANK[planoDe(plano)] >= RANK[minimo]
}

/** O alvo é um rebaixamento em relação ao atual? */
export function ehRebaixamento(atual: unknown, alvo: unknown): boolean {
  return RANK[planoDe(alvo)] < RANK[planoDe(atual)]
}

/**
 * ATÉ QUANDO o plano contratado ainda vale. `null` = sem prazo (o caso do Free e o
 * de uma assinatura ativa cuja renovação o provedor confirma sozinho).
 *
 * Cada estado tem um relógio diferente, e é aqui que essa diferença mora — em um
 * lugar só, para não haver duas respostas para a mesma pergunta em dois arquivos.
 */
export function valeAte(p: EstadoAssinatura): Date | null {
  const status = statusDe(p.planStatus)
  const fim = data(p.currentPeriodEnd)
  const carencia = data(p.graceUntil)

  // Sanção que pausou a cobrança não corre relógio: seria cobrar o prazo de quem
  // está impedido de usar. O acesso fica de pé até a medida ser resolvida.
  if (status === 'paused') return null

  // Cancelada: quem pagou o mês tem o mês. Sem período gravado (cancelamento de
  // algo que nunca chegou a ser pago), acaba agora.
  if (status === 'canceled') return fim ?? new Date(0)

  // Pagamento falhou: vale até o fim da carência — ou até o fim do período pago, o
  // que for MAIOR. Um cartão que falha na renovação não pode encurtar um mês que
  // já estava pago.
  if (status === 'past_due') {
    if (!carencia && !fim) return null
    return new Date(Math.max(carencia?.getTime() ?? 0, fim?.getTime() ?? 0))
  }

  // Ativa: o período pago, com a folga do webhook atrasado.
  return fim ? somarDias(fim, TOLERANCIA_RENOVACAO_DIAS) : null
}

/**
 * O PLANO QUE VALE AGORA. É esta função — e não `Profile.plan` — que decide o que
 * o perfil entrega: tema, agendamento, vídeo, FAQ, IA, métricas.
 *
 * `Profile.plan` continua sendo "o que a pessoa CONTRATOU", e é por isso que ele
 * não é rebaixado no banco assim que o prazo vence: preservá-lo é o que permite
 * religar tudo no instante em que o pagamento entra, sem a pessoa refazer nada — e
 * é o que deixa o painel dizer "seu Max está suspenso" em vez de fingir que nunca
 * houve um Max.
 */
export function planoVigente(p: EstadoAssinatura, agora: Date = new Date()): Plan {
  const contratado = planoDe(p.plan)
  if (contratado === 'free') return 'free'
  const ate = valeAte(p)
  if (!ate) return contratado
  return ate.getTime() > agora.getTime() ? contratado : 'free'
}

/** O acesso pago está de pé só por causa de uma carência/período residual? */
export function emCortesia(p: EstadoAssinatura, agora: Date = new Date()): boolean {
  const status = statusDe(p.planStatus)
  if (status !== 'past_due' && status !== 'canceled') return false
  return planoVigente(p, agora) !== 'free'
}

/** Já venceu e ainda não foi reconciliado no banco? (usado pela varredura diária) */
export function venceu(p: EstadoAssinatura, agora: Date = new Date()): boolean {
  return planoDe(p.plan) !== 'free' && planoVigente(p, agora) === 'free'
}

/**
 * O prazo do endereço acabou? (também da varredura diária)
 *
 * Só responde `true` quando há prazo marcado E ele passou E o plano vigente é
 * mesmo o Free — quem reassinou no meio da semana tem o prazo apagado por
 * `aplicarAssinatura`, e esta conferência é a segunda tranca: um relógio adiantado
 * ou uma linha esquecida não podem renumerar o endereço de quem está pagando.
 */
export function enderecoVenceu(p: EstadoAssinatura, agora: Date = new Date()): boolean {
  const prazo = data(p.slugGraceUntil)
  if (!prazo) return false
  if (planoVigente(p, agora) !== 'free') return false
  return prazo.getTime() <= agora.getTime()
}

/** Quando o endereço limpo passa a ser prazo: no instante em que o plano vira Free. */
export function aoPerderOPlano(agora: Date = new Date()): Date {
  return somarDias(agora, CARENCIA_ENDERECO_DIAS)
}

// ---- Transições -------------------------------------------------------------
//
// Funções PURAS: recebem o estado e devolvem o patch a gravar. Ficam fora do
// serviço de propósito — é a única parte da cobrança que dá para testar sem banco,
// e é justamente a parte em que um erro custa dinheiro de verdade.

export interface PatchAssinatura {
  plan?: Plan
  planStatus?: PlanStatus
  currentPeriodEnd?: Date | null
  graceUntil?: Date | null
  planScheduled?: Plan | null
  /**
   * NÃO é escrito pelas transições deste arquivo: quem decide o prazo do endereço
   * é `aplicarAssinatura`, que é quem sabe qual era o endereço antes. Fica no tipo
   * para a varredura poder zerá-lo ao carimbar.
   */
  slugGraceUntil?: Date | null
}

/** Pagamento confirmado (assinatura nova ou renovação). Zera qualquer carência. */
export function aoConfirmarPagamento(plano: Plan, fimDoPeriodo: Date | null): PatchAssinatura {
  return { plan: plano, planStatus: 'active', currentPeriodEnd: fimDoPeriodo, graceUntil: null }
}

/**
 * Cobrança falhou. Abre a carência UMA vez: cada nova tentativa frustrada do
 * provedor voltaria a empurrar o prazo para frente, e a carência nunca venceria.
 */
export function aoFalharPagamento(p: EstadoAssinatura, agora: Date = new Date()): PatchAssinatura {
  return { planStatus: 'past_due', graceUntil: data(p.graceUntil) ?? somarDias(agora, CARENCIA_DIAS) }
}

/**
 * Assinatura encerrada (a pessoa pediu o cancelamento, ou o provedor desistiu de
 * cobrar). O acesso NÃO cai agora: cai no fim do que já foi pago.
 */
export function aoCancelar(p: EstadoAssinatura, agora: Date = new Date()): PatchAssinatura {
  return {
    planStatus: 'canceled',
    // Sem período pago conhecido, o encerramento vale a partir de agora — mas ainda
    // passa pelo mesmo caminho de leitura, sem apagar `plan`.
    currentPeriodEnd: data(p.currentPeriodEnd) ?? agora,
    graceUntil: null,
    planScheduled: null,
  }
}

/** Sanção suspendeu a cobrança. */
export function aoPausar(): PatchAssinatura {
  return { planStatus: 'paused' }
}

/** Sanção resolvida: a cobrança volta a correr. */
export function aoRetomar(): PatchAssinatura {
  return { planStatus: 'active' }
}

/**
 * Troca de plano pedida pela pessoa.
 *
 * SUBIR é imediato — ela está pagando mais e quer usar agora.
 * DESCER é AGENDADO para o fim do período já pago: cobrar um mês de Max e entregar
 * Pro no dia seguinte é vender o que não se entrega. O rebaixamento fica guardado
 * em `planScheduled` e a varredura diária o aplica quando o período vira.
 *
 * Cair para o Free é um cancelamento — mesmo caminho, mesma regra.
 */
export function aoTrocarPlano(
  p: EstadoAssinatura,
  alvo: Plan,
  agora: Date = new Date(),
): PatchAssinatura {
  const atual = planoDe(p.plan)
  if (alvo === atual) return {}

  if (!ehRebaixamento(atual, alvo)) {
    // Subir cancela um rebaixamento agendado: quem sobe desistiu de descer, e
    // deixar o agendamento de pé rebaixaria a pessoa no fim do mês logo depois de
    // ela ter comprado o plano maior.
    return { plan: alvo, planStatus: 'active', graceUntil: null, planScheduled: null }
  }

  if (alvo === 'free') return aoCancelar(p, agora)

  const fim = data(p.currentPeriodEnd)
  // Sem período pago (assinatura simulada, ou plano concedido por escritório), o
  // rebaixamento vale já — não há mês pago a respeitar.
  if (!fim || fim.getTime() <= agora.getTime()) {
    return { plan: alvo, planStatus: 'active', planScheduled: null, graceUntil: null }
  }
  return { planScheduled: alvo }
}

/**
 * O que a varredura diária deve gravar quando o prazo virou. Devolve `null` quando
 * não há nada a fazer — a varredura é idempotente por construção.
 */
export function aoVirarOPrazo(
  p: EstadoAssinatura,
  agora: Date = new Date(),
): PatchAssinatura | null {
  const alvo = p.planScheduled
  const fim = data(p.currentPeriodEnd)

  // Rebaixamento agendado cujo período acabou: aplica agora.
  if (alvo && fim && fim.getTime() <= agora.getTime()) {
    return { plan: planoDe(alvo), planStatus: 'active', planScheduled: null, graceUntil: null }
  }

  // Assinatura vencida de vez (carência esgotada ou cancelamento maduro): o plano
  // CONTRATADO cai para free. Só aqui, e só depois de todo o prazo — o conteúdo
  // continua no banco (ver profiles.service: rebaixar esconde, não apaga).
  if (venceu(p, agora)) {
    return { plan: 'free', planStatus: 'canceled', planScheduled: null, graceUntil: null }
  }

  return null
}
