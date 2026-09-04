// Limites por plano — FONTE DA VERDADE (o front espelha em frontend/src/lib/plans.ts).
export type Plan = 'free' | 'pro' | 'premium'
export type LimitedField = 'headline' | 'bio' | 'areaDesc'

// O Free é APERTADO de propósito (revisão de 04/09/2026): UMA área, UMA pergunta
// e campos curtos. Cota de um com campo largo é uma regra que se anula sozinha —
// vira convite a empilhar ("Família, Sucessões e Inventários" num rótulo só).
// Os planos pagos ficam folgados: lá a cota já dá o espaço.
export const CHAR_LIMITS: Record<Plan, Record<LimitedField, number>> = {
  free: { headline: 50, bio: 240, areaDesc: 110 },
  pro: { headline: 90, bio: 600, areaDesc: 280 },
  premium: { headline: 120, bio: 1000, areaDesc: 400 },
}

export function limitsFor(plan: string | undefined): Record<LimitedField, number> {
  return CHAR_LIMITS[(plan as Plan) in CHAR_LIMITS ? (plan as Plan) : 'free']
}

// Tetos FIXOS (iguais em todos os planos) — sanidade/anti-abuso.
export const NAME_MAX = 70
export const OAB_MAX = 20

// ---- Limites de QUANTIDADE por plano (o front espelha em lib/plans.ts) ----
// Áreas de atuação e perguntas frequentes. O servidor é a
// fonte da verdade: o excedente é CORTADO no save (não derruba a requisição, para
// não travar quem acabou de fazer downgrade).
export const AREA_LIMIT: Record<Plan, number> = { free: 1, pro: 6, premium: 20 }
// Perguntas frequentes respondidas no perfil: nenhuma no Free, 2 no Pro, 5 no Max.
export const FAQ_LIMIT: Record<Plan, number> = { free: 1, pro: 2, premium: 5 }

// Tetos de texto do FAQ (iguais em todos os planos — quem tem, tem por inteiro).
// CURTOS de propósito: FAQ é orientação geral, não parecer jurídico. Resposta longa
// no celular vira parede de texto que ninguém lê — e quanto mais texto, mais chance
// de escorregar para fora do que o Prov. 205/2021 permite.
// Tetos de TEXTO por plano — eram números fixos até 04/09/2026. Use `countLimit`
// para ler com um plano em mãos.
export const AREA_LABEL_MAX: Record<Plan, number> = { free: 32, pro: 40, premium: 40 }
export const FAQ_QUESTION_MAX: Record<Plan, number> = { free: 80, pro: 100, premium: 100 }
// 300 → 220 em 27/08/2026. A 300, a IA escrevia até encostar no teto e a resposta
// saía com cinco linhas no celular. 220 cabe em duas ou três frases.
//
// ⚠️ Espelha frontend/src/lib/plans.ts. Este número também vai para o PROMPT da
// IA (ai.service.ts) — mudar aqui muda o que o modelo recebe como instrução.
export const FAQ_ANSWER_MAX: Record<Plan, number> = { free: 160, pro: 220, premium: 220 }

export function countLimit(
  table: Record<Plan, number>,
  plan: string | undefined,
): number {
  return table[(plan as Plan) in table ? (plan as Plan) : 'free']
}

// Perguntas frequentes no perfil — recurso dos planos pagos (2 no Pro, 5 no Max).
/**
 * Responder perguntas frequentes no perfil. Deixou de ser "recurso pago" em
 * 04/09/2026 e passou a ser a leitura da tabela: cota maior que zero. Assim o
 * portão nunca discorda do número anunciado.
 */
export function canUseFaq(plan: string | undefined): boolean {
  return countLimit(FAQ_LIMIT, plan) > 0
}

// ---- Temas visuais ----
// Tema → plano mínimo. ESPELHA o campo `tier` de frontend/src/lib/themes.ts.
// O editor deixa PROVAR um tema travado (ele entra só na prévia), então o servidor
// precisa ser quem decide o que fica salvo — a prova não pode virar persistência
// por um PUT forjado.
export const THEME_TIER: Record<string, Plan> = {
  papel: 'free',
  nevoa: 'free',
  esmeralda: 'pro',
  toga: 'pro',
  ardosia: 'pro',
  'meia-noite': 'premium',
  obsidian: 'premium',
  marmore: 'premium',
}
export const DEFAULT_THEME = 'papel'

const PLAN_RANK: Record<Plan, number> = { free: 0, pro: 1, premium: 2 }

/**
 * Tema que pode de fato ser salvo neste plano. Tema desconhecido ou acima do
 * plano cai para o neutro — é também o que reconcilia um downgrade.
 */
export function resolveTheme(theme: unknown, plan: string | undefined): string {
  const id = typeof theme === 'string' ? theme : DEFAULT_THEME
  const tier = THEME_TIER[id]
  if (!tier) return DEFAULT_THEME
  const rank = PLAN_RANK[(plan as Plan) in PLAN_RANK ? (plan as Plan) : 'free']
  return rank >= PLAN_RANK[tier] ? id : DEFAULT_THEME
}

// Agendamento (link externo OU agenda nativa) — recurso dos planos pagos.
// No Free não há botão "Agendar" no perfil.
export function canUseScheduling(plan: string | undefined): boolean {
  return plan === 'pro' || plan === 'premium'
}

// Modelos e teto de texto do cartão impresso — espelha frontend/src/lib/cardArt.ts.
export const CARD_TEMPLATES = ['timbre', 'razao', 'reto'] as const
export const CARD_TAGLINE_MAX = 48

// Cartão de visita para IMPRIMIR (arte com sangria e marcas de corte) — só no Max.
// Espelha canUsePrintCard de frontend/src/lib/plans.ts.
export function canUsePrintCard(plan: string | undefined): boolean {
  return plan === 'premium'
}

// Agenda nativa (cliente marca dia/hora, advogado aceita/recusa) — também só nos pagos.
export function canUseNativeAgenda(plan: string | undefined): boolean {
  return plan === 'pro' || plan === 'premium'
}

// ---- Plano Escritório (sociedade de advogados) — FONTE DA VERDADE ----
// Preço: R$ 99/mês incluindo 5 advogados; cada assento adicional custa R$ 20/mês.
// Valores em reais (inteiros). O billing real (Stripe) entra depois; hoje derivamos
// o preço do nº de assentos ativos.
export const FIRM_PRICING = {
  basePrice: 99, // R$/mês (inclui os assentos-base)
  includedSeats: 5,
  extraSeatPrice: 20, // R$/mês por advogado além dos incluídos
} as const

// Preço mensal do escritório para um dado nº de assentos (advogados ativos).
export function firmMonthlyPrice(seats: number): number {
  const extra = Math.max(0, seats - FIRM_PRICING.includedSeats)
  return FIRM_PRICING.basePrice + extra * FIRM_PRICING.extraSeatPrice
}

// Limites de conteúdo institucional do escritório (análogos aos de perfil).
export const FIRM_LIMITS = { tagline: 120, about: 1200 } as const

// Gera o slug base a partir do nome (mesma regra do frontend).
// Teto do endereço público. Sem ele, um nome de 8 mil caracteres virava um slug
// de 8 mil caracteres — chave única gigante no banco e URL que ninguém abre.
export const SLUG_MAX = 60

export function slugify(s: unknown): string {
  return (
    String(s ?? '')
      .slice(0, 200)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, SLUG_MAX)
      .replace(/-$/, '') || 'perfil'
  )
}
