// Constantes de moderação — fonte da verdade compartilhada com o frontend
// (espelhe em frontend/src/lib/reportReasons.ts). Motivos pré-prontos derivam
// diretamente das vedações do REGRAS.md (Prov. 205/2021 + CED).

/** Motivos de denúncia pré-prontos. `other` exige detalhes livres. */
export const REPORT_REASONS = [
  'oab_invalid',
  'result_promise',
  'pricing',
  'self_aggrandizement',
  'solicitation',
  'client_exposure',
  'impersonation',
  'offensive',
  'other',
] as const

export type ReportReason = (typeof REPORT_REASONS)[number]

export function isValidReason(v: unknown): v is ReportReason {
  return typeof v === 'string' && (REPORT_REASONS as readonly string[]).includes(v)
}

/**
 * Chaves de seção que o admin pode censurar (moderationStatus = partial).
 * Áreas individuais usam o prefixo `area:<id>`. O getBySlug remove o conteúdo
 * correspondente antes de enviar ao público.
 */
export const SECTION_KEYS = [
  'avatar',
  'headline',
  'bio',
  'areas',
  'highlights',
  'socials',
  'regionNote',
] as const

export type SectionKey = (typeof SECTION_KEYS)[number]

/** Ações de moderação que o admin pode aplicar a um perfil. */
export const MODERATION_ACTIONS = ['warn', 'partial', 'restrict', 'clear'] as const
export type ModerationAction = (typeof MODERATION_ACTIONS)[number]

export function isValidAction(v: unknown): v is ModerationAction {
  return typeof v === 'string' && (MODERATION_ACTIONS as readonly string[]).includes(v)
}
