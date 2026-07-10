// Limites por plano — FONTE DA VERDADE (o front espelha em frontend/src/lib/plans.ts).
export type Plan = 'free' | 'pro' | 'premium'
export type LimitedField = 'headline' | 'bio' | 'areaDesc' | 'highlightTitle' | 'highlightDetail'

export const CHAR_LIMITS: Record<Plan, Record<LimitedField, number>> = {
  free: { headline: 60, bio: 300, areaDesc: 160, highlightTitle: 40, highlightDetail: 80 },
  pro: { headline: 90, bio: 600, areaDesc: 280, highlightTitle: 60, highlightDetail: 140 },
  premium: { headline: 120, bio: 1000, areaDesc: 400, highlightTitle: 80, highlightDetail: 200 },
}

export function limitsFor(plan: string | undefined): Record<LimitedField, number> {
  return CHAR_LIMITS[(plan as Plan) in CHAR_LIMITS ? (plan as Plan) : 'free']
}

// Tetos FIXOS (iguais em todos os planos) — sanidade/anti-abuso.
export const NAME_MAX = 70
export const OAB_MAX = 20

// Agendamento (link externo OU agenda nativa) — recurso dos planos pagos.
// No Free não há botão "Agendar" no perfil.
export function canUseScheduling(plan: string | undefined): boolean {
  return plan === 'pro' || plan === 'premium'
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
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'perfil'
  )
}
