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
