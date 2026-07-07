// Guarda-corpo de conformidade OAB (Prov. 205/2021) — MOTOR DE REGRAS VERSIONADO.
// O frontend dá feedback imediato; o backend é a fonte da verdade antes de publicar.
//
// ⚠️ MANTER EM SINCRONIA com frontend/src/lib/oab.ts (mesmas regras e mesma versão).
// A camada de política é versionada: quando o Provimento for revisado, suba RULESET_REV
// e/ou POLICY_VERSION e registre a mudança na tabela PolicyVersion (ver schema.prisma).

/** Versão da política de publicidade vigente aplicada às verificações. */
export const POLICY_VERSION = 'Prov. 205/2021'
/** Revisão interna do conjunto de regras (incrementar a cada ajuste de RULES). */
export const RULESET_REV = 2

export type Severity = 'block' | 'warn'

export interface ComplianceIssue {
  /** identificador estável da regra que disparou (útil para logs/auditoria) */
  ruleId: string
  /** trecho do texto que casou com a regra */
  term: string
  reason: string
  severity: Severity
}

export interface Rule {
  id: string
  test: RegExp
  reason: string
  severity: Severity
}

// Regras codificadas a partir do Prov. 205/2021 (Art. 3º–6º) e do Código de Ética.
// Novas regras podem ser adicionadas aqui (ou, no futuro, carregadas de config/DB).
export const RULES: Rule[] = [
  {
    id: 'promise-result',
    test: /\b(garant\w+|assegur\w+|100%|resultado garantido|(êxito|exito|vitória|vitoria|ganho|sucesso) garantid\w+|certeza de (ganho|êxito|exito|vitória|vitoria))\b/i,
    reason: 'Promessa/garantia de resultado é vedada (Prov. 205/2021 Art. 6º).',
    severity: 'block',
  },
  {
    id: 'superlative-comparison',
    test: /\b(o|a) melhor\b|\b(n[ºo°]\.? ?1|número um|numero um|imbatív\w+|imbativ\w+|líder de mercado|lider de mercado|referência (nacional|no mercado)|o mais (premiado|renomado|reconhecido)|único (advogad|escritóri))\b/i,
    reason: 'Autoengrandecimento / comparação é vedado (Prov. 205/2021 Art. 3º, IV).',
    severity: 'block',
  },
  {
    id: 'price-fee-discount',
    test: /\b(honorári\w+|preç\w+|r\$ ?\d|desconto|promoç\w+|parcel\w+|liquidaç\w+|menor preço)\b/i,
    reason: 'Menção a preços/honorários/descontos é vedada (Prov. 205/2021 Art. 3º, I).',
    severity: 'block',
  },
  {
    id: 'free-bait',
    test: /\b(consulta (grátis|gratis|gratuita)|primeira consulta gratuita|de graça|sem custo|análise gratuita|avaliação gratuita)\b/i,
    reason: 'Oferta de serviço gratuito como isca (captação de clientela) é vedada.',
    severity: 'block',
  },
  {
    id: 'cta-hire',
    test: /\b(contrate|contrata[- ]?me|contrate agora|clique (aqui|e (agende|contrate))|feche com|feche seu contrato)\b/i,
    reason: 'Chamada direta à contratação (CTA) é captação vedada (CED Art. 46).',
    severity: 'block',
  },
  {
    id: 'oab-symbol',
    test: /\b(selo (da |de |oficial )?oab|chancela(do)? (pela|da) oab|aprovad\w+ pela oab|logo(tipo)? da oab|símbolo da oab|simbolo da oab)\b/i,
    reason: 'Uso de selo/símbolo/chancela oficial da OAB é vedado (Prov. 205/2021 Art. 5º, §2º).',
    severity: 'block',
  },
  {
    id: 'client-case-secrecy',
    test: /\b(ganhei o caso do|processo do cliente|caso [A-Z]\w+ vs|meu cliente \w+ (ganhou|venceu))\b/i,
    reason: 'Exposição de caso/cliente identificável viola o sigilo profissional.',
    severity: 'block',
  },
  {
    id: 'testimonials-clientlist',
    test: /\b(depoimentos?|clientes satisfeit\w+|lista de clientes|nossos clientes incluem|trabalhamos com \p{Lu})/iu,
    reason: 'Depoimentos e lista de clientes são vedados (CED Art. 42, IV/V).',
    severity: 'block',
  },
  {
    id: 'paid-ranking',
    test: /\b(top \d+ advogad|melhores advogados|prêmio (de|melhor)|ranking pago|advogado premiad)/i,
    reason: 'Ranking/prêmio pago é vedado (Prov. 205/2021 Art. 5º, §1º).',
    severity: 'warn',
  },
  {
    id: 'urgency-appeal',
    test: /\b(fale comigo agora|não perca tempo|nao perca tempo|corra|últimas vagas|ultimas vagas|aproveite (já|agora)|atendimento 24 ?h|agende (já|agora mesmo)|ligue agora)\b/i,
    reason: 'Apelo de urgência / captação de clientela — reveja o tom.',
    severity: 'warn',
  },
  {
    id: 'giveaway',
    test: /\b(sorteio|brinde grátis|brinde gratis|sorteando|dou de brinde)\b/i,
    reason: 'Distribuição de brindes/sorteios como isca é vedada (Prov. 205/2021 Art. 3º, V).',
    severity: 'warn',
  },
]

export function checkCompliance(text: string): ComplianceIssue[] {
  const issues: ComplianceIssue[] = []
  if (!text) return issues
  for (const rule of RULES) {
    const m = text.match(rule.test)
    if (m) {
      issues.push({ ruleId: rule.id, term: m[0], reason: rule.reason, severity: rule.severity })
    }
  }
  return issues
}

export function hasBlockingIssue(text: string): boolean {
  return checkCompliance(text).some((i) => i.severity === 'block')
}

export type ComplianceStatus = 'ok' | 'warn' | 'block'

/** Status agregado de um texto sob a política vigente. */
export function complianceStatus(text: string): ComplianceStatus {
  const issues = checkCompliance(text)
  if (issues.some((i) => i.severity === 'block')) return 'block'
  if (issues.length > 0) return 'warn'
  return 'ok'
}
