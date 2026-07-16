// Guarda-corpo de conformidade OAB (Prov. 205/2021) — MOTOR DE REGRAS VERSIONADO.
// O frontend dá feedback imediato; o backend é a FONTE DA VERDADE antes de publicar.
//
// As regras (dados/regex) vivem em ./oab.rules.ts — este arquivo contém apenas a
// LÓGICA de avaliação. Documentação: docs/motor-de-conformidade.md.
//
// ⚠️ MANTER EM SINCRONIA com frontend/src/lib/oab.ts (+ oab.rules.ts). A trava de
// paridade garante que os conjuntos de regras não divirjam (ver oab.rules.spec.ts).

import {
  CATEGORIES,
  computeRulesetFingerprint,
  POLICY_VERSION,
  RULES,
  RULESET_REV,
  type Rule,
  type RuleCategory,
  type Severity,
} from './oab.rules'

export { CATEGORIES, POLICY_VERSION, RULES, RULESET_REV }
export type { Rule, RuleCategory, Severity }

/**
 * Apontamento de conformidade — explica EXATAMENTE por quê um trecho foi sinalizado.
 * `term`/`reason` são aliases mantidos por retrocompatibilidade dos consumidores.
 */
export interface ComplianceIssue {
  /** identificador estável da regra que disparou */
  ruleId: string
  /** categoria da vedação */
  category: RuleCategory
  /** gravidade: 'block' impede publicação; 'warn' apenas alerta */
  severity: Severity
  /** versão da política aplicada */
  version: string
  /** trecho do texto que casou com a regra */
  matchedText: string
  /** explicação didática: por que é vedado */
  explanation: string
  /** sugestão de correção acionável */
  suggestion: string
  // ---- aliases (retrocompatibilidade) ----
  /** @deprecated use matchedText */
  term: string
  /** @deprecated use explanation; motivo curto (cabeçalho) */
  reason: string
}

function toIssue(rule: Rule, matchedText: string): ComplianceIssue {
  return {
    ruleId: rule.id,
    category: rule.category,
    severity: rule.severity,
    version: rule.version,
    matchedText,
    explanation: rule.explanation,
    suggestion: rule.suggestion,
    term: matchedText,
    reason: rule.reason,
  }
}

export function checkCompliance(text: string): ComplianceIssue[] {
  const issues: ComplianceIssue[] = []
  if (!text) return issues
  for (const rule of RULES) {
    const m = text.match(rule.test)
    if (m) issues.push(toIssue(rule, m[0]))
  }
  return issues
}

export function hasBlockingIssue(text: string): boolean {
  return checkCompliance(text).some((i) => i.severity === 'block')
}

/**
 * Monitor de mudanças normativas: true quando o perfil foi conferido sob uma
 * revisão anterior do conjunto de regras (RULESET_REV atual é maior). Nesse caso o
 * conteúdo deve ser reavaliado. Espelha frontend/src/lib/oab.ts (policyOutdated).
 */
export function policyOutdated(policyRevChecked?: number | null): boolean {
  return (policyRevChecked ?? 0) < RULESET_REV
}

export type ComplianceStatus = 'ok' | 'warn' | 'block'

/** Status agregado de um texto sob a política vigente. */
export function complianceStatus(text: string): ComplianceStatus {
  const issues = checkCompliance(text)
  if (issues.some((i) => i.severity === 'block')) return 'block'
  if (issues.length > 0) return 'warn'
  return 'ok'
}

/** Fingerprint do ruleset — reexportado para a trava de paridade. */
export { computeRulesetFingerprint }
