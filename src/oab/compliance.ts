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

// ---- INVENTÁRIO DO QUE O VISITANTE LÊ --------------------------------------
//
// Fonte ÚNICA da resposta para "que textos passam pela conformidade?". Antes essa
// lista era implícita e vivia duplicada: o backend checava bio + descrição de área
// + FAQ, e o editor só avisava na bio. Resultado — a FRASE DE APRESENTAÇÃO, que é
// a linha mais visível do perfil depois do nome, não era checada em lugar nenhum:
// dava para publicar "O melhor criminalista de SP" ali sem um aviso sequer.
//
// Regra: se aparece na página pública, entra aqui. Campo novo no perfil que o
// visitante enxergue tem de ser acrescentado nesta lista — nos DOIS espelhos.

/** Forma frouxa aceita pelo inventário: serve tanto ao Profile do front quanto ao
 *  corpo do PUT recebido pelo backend. */
export interface PublicTextSource {
  headline?: string | null
  bio?: string | null
  regionNote?: string | null
  videoCaption?: string | null
  areas?: { label?: string | null; description?: string | null }[] | null
  faqs?: { question?: string | null; answer?: string | null }[] | null
  branding?: { brandName?: string | null } | null
  assistant?: { greeting?: string | null } | null
}

export interface PublicText {
  /** rótulo humano do campo — é o que o aviso mostra ("Frase de apresentação") */
  label: string
  /** seção do editor que edita o campo, para o link "corrigir" */
  section: string
  text: string
}

/** Todo texto público do perfil, rotulado. Vazios são descartados. */
export function publicTexts(p: PublicTextSource): PublicText[] {
  const out: PublicText[] = []
  const add = (label: string, section: string, text?: string | null) => {
    if (typeof text === 'string' && text.trim()) out.push({ label, section, text })
  }

  add('Frase de apresentação', 'identidade', p.headline)
  add('Apresentação', 'bio', p.bio)
  add('Observação de atendimento', 'identidade', p.regionNote)
  for (const a of p.areas ?? []) {
    add('Nome da área de atuação', 'identidade', a?.label)
    add('Descrição da área de atuação', 'identidade', a?.description)
  }
  for (const f of p.faqs ?? []) {
    add('Pergunta frequente', 'faq', f?.question)
    add('Resposta da pergunta frequente', 'faq', f?.answer)
  }
  add('Legenda do vídeo', 'video', p.videoCaption)
  add('Abertura do assistente', 'agenda', p.assistant?.greeting)
  add('Nome no rodapé do perfil', 'marca', p.branding?.brandName)

  return out
}

/** Cada texto público com os apontamentos que ele gera (só os que têm algum). */
export function publicIssues(p: PublicTextSource): (PublicText & { issues: ComplianceIssue[] })[] {
  return publicTexts(p)
    .map((t) => ({ ...t, issues: checkCompliance(t.text) }))
    .filter((t) => t.issues.length > 0)
}

/** Campos que IMPEDEM a publicação (têm apontamento de severidade 'block'). */
export function blockingFields(p: PublicTextSource): string[] {
  const labels = publicIssues(p)
    .filter((t) => t.issues.some((i) => i.severity === 'block'))
    .map((t) => t.label)
  return [...new Set(labels)]
}

/** Pior status entre TODOS os textos públicos — é o que vai para a auditoria. */
export function publicStatus(p: PublicTextSource): ComplianceStatus {
  let worst: ComplianceStatus = 'ok'
  for (const t of publicTexts(p)) {
    const s = complianceStatus(t.text)
    if (s === 'block') return 'block'
    if (s === 'warn') worst = 'warn'
  }
  return worst
}
