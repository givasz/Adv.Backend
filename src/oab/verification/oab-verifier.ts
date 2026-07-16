// Estratégia de conferência de OAB — DESACOPLADA por trás de uma interface.
// Hoje só existe o verificador MANUAL (revisão por admin). A arquitetura já está
// pronta para plugar verificadores automáticos (CNA web service, ConfirmADV) sem
// tocar no serviço de verificação. Ver docs/oab-verificacao-escalonamento.md.

export type OabVerificationMethod = 'manual' | 'cna_ws' | 'confirmadv'

/** Dados mínimos para conferir uma inscrição. */
export interface OabCheckInput {
  oabNumber: string
  name: string
  state?: string
}

/** Resultado de uma tentativa de conferência. */
export interface OabCheckResult {
  /**
   * - 'requires_review' → precisa de decisão humana (fluxo manual);
   * - 'verified' / 'rejected' → decisão automática (futuros verificadores).
   */
  outcome: 'requires_review' | 'verified' | 'rejected'
  method: OabVerificationMethod
  /** observação/motivo (ex.: divergência de nome, situação irregular). */
  reason?: string
}

export interface OabVerifier {
  readonly method: OabVerificationMethod
  check(input: OabCheckInput): Promise<OabCheckResult>
}

// Fase 1 — MVP: conferência manual por admin. O verificador nunca decide sozinho:
// coloca o perfil em análise e devolve 'requires_review'. A decisão fica no admin.
export class ManualOabVerifier implements OabVerifier {
  readonly method: OabVerificationMethod = 'manual'
  async check(_input: OabCheckInput): Promise<OabCheckResult> {
    return { outcome: 'requires_review', method: 'manual' }
  }
}

// Placeholder das fases 2/3 — mantidos como referência da arquitetura extensível.
// Quando implementados, ficam atrás de env (OAB_CNA_WS_ENABLED / OAB_CONFIRMADV_ENABLED)
// e SEMPRE com fallback para o manual. Não devem conceder "verified" a partir de dado
// auto-declarado — apenas acelerar/assistir a conferência.

/**
 * Seleciona o verificador ativo. Ponto ÚNICO de troca de estratégia — o resto do
 * sistema depende só da interface OabVerifier.
 */
export function resolveOabVerifier(): OabVerifier {
  // Futuro (atrás de flag):
  //   if (process.env.OAB_CONFIRMADV_ENABLED === 'true') return new ConfirmAdvVerifier()
  //   if (process.env.OAB_CNA_WS_ENABLED === 'true') return new CnaWsVerifier()
  return new ManualOabVerifier()
}
