// ⚖️  MOTOR DE CONFORMIDADE OAB — CONJUNTO DE REGRAS (dados, sem lógica).
// ---------------------------------------------------------------------------
// Este arquivo concentra TODA a regex/heurística de publicidade advocatícia num
// único lugar por pacote (evita regex espalhadas). A lógica de avaliação vive em
// ./compliance.ts. Documentação completa: docs/motor-de-conformidade.md.
//
// ⚠️  ESPELHO: mantido IDÊNTICO a frontend/src/lib/oab.rules.ts. A trava de
// paridade (RULESET_FINGERPRINT + docs/oab-ruleset.lock) quebra os testes se os
// dois lados divergirem — ver oab.rules.spec.ts. Ao editar regras: edite os DOIS
// arquivos, incremente RULESET_REV e atualize docs/oab-ruleset.lock com o valor
// que o teste de paridade imprimir (npm test).
//
// Fontes normativas: Provimento 205/2021 (CFOAB, Art. 3º–6º) e Código de Ética e
// Disciplina (Res. 02/2015). Ver REGRAS.md. Princípio: na dúvida, o mais restritivo.

/** Versão da política de publicidade vigente aplicada às verificações. */
export const POLICY_VERSION = 'Prov. 205/2021'

/**
 * Revisão interna do conjunto de regras. INCREMENTAR a cada mudança em RULES.
 * Monitor normativo: perfis conferidos sob revisão anterior são reavaliados.
 */
export const RULESET_REV = 3

export type Severity = 'block' | 'warn'

/** Categoria da regra — agrupa vedações afins (usada em UI, filtros e testes). */
export type RuleCategory =
  | 'promise' // promessa/garantia de resultado
  | 'comparison' // superlativos / autoengrandecimento / comparação
  | 'commercialization' // mercantilização/linguagem de venda genérica
  | 'price' // menção a honorários/preços
  | 'discount' // descontos, promoções, formas de pagamento
  | 'free-bait' // gratuidade como isca de captação
  | 'urgency' // apelo de urgência
  | 'cta' // chamada direta à contratação
  | 'testimonial' // depoimentos / lista de clientes
  | 'secrecy' // exposição de caso/cliente (sigilo)
  | 'oab-misuse' // uso indevido de selo/símbolo/chancela da OAB
  | 'giveaway' // brindes / sorteios
  | 'paid-ranking' // ranking/prêmio pago

/** Metadados de cada categoria (rótulo + base legal), para exibição na UI. */
export const CATEGORIES: Record<RuleCategory, { label: string; basis: string }> = {
  promise: { label: 'Promessa de resultado', basis: 'Prov. 205/2021 Art. 6º' },
  comparison: { label: 'Superlativo / comparação', basis: 'Prov. 205/2021 Art. 3º, IV' },
  commercialization: { label: 'Mercantilização', basis: 'Prov. 205/2021 Art. 3º (caput)' },
  price: { label: 'Preços e honorários', basis: 'Prov. 205/2021 Art. 3º, I' },
  discount: { label: 'Descontos e pagamento', basis: 'Prov. 205/2021 Art. 3º, I' },
  'free-bait': { label: 'Gratuidade como isca', basis: 'CED Art. 30 · Prov. 205/2021 Art. 3º, I' },
  urgency: { label: 'Apelo de urgência', basis: 'CED Art. 46 · Prov. 205/2021 Art. 3º' },
  cta: { label: 'Chamada à contratação', basis: 'CED Art. 46' },
  testimonial: { label: 'Depoimentos / clientes', basis: 'CED Art. 42, IV/V' },
  secrecy: { label: 'Sigilo profissional', basis: 'CED Art. 35–38 · Prov. 205/2021 Art. 5º §3º' },
  'oab-misuse': { label: 'Uso indevido da OAB', basis: 'Prov. 205/2021 Art. 5º, §2º' },
  giveaway: { label: 'Brindes / sorteios', basis: 'Prov. 205/2021 Art. 3º, V' },
  'paid-ranking': { label: 'Ranking pago', basis: 'Prov. 205/2021 Art. 5º, §1º' },
}

export interface Rule {
  /** identificador estável da regra (logs/auditoria/UI) */
  id: string
  /** categoria da vedação */
  category: RuleCategory
  /** gravidade: 'block' impede publicação; 'warn' apenas alerta */
  severity: Severity
  /** versão da política de onde a regra deriva */
  version: string
  /** expressão que detecta a violação */
  test: RegExp
  /** motivo curto (cabeçalho do apontamento) */
  reason: string
  /** explicação didática: por que é vedado */
  explanation: string
  /** sugestão de correção acionável */
  suggestion: string
  /** exemplos que DEVEM disparar a regra (para testes/documentação) */
  examplesForbidden: string[]
  /** exemplos correlatos que NÃO podem disparar falso-positivo */
  examplesAllowed: string[]
}

// Regras codificadas a partir do Prov. 205/2021 (Art. 3º–6º) e do CED.
// Para adicionar uma regra: acrescente um objeto aqui (nos DOIS espelhos),
// preencha todos os campos, cubra com exemplos e rode `npm run oab:lock`.
export const RULES: Rule[] = [
  {
    id: 'promise-result',
    category: 'promise',
    severity: 'block',
    version: POLICY_VERSION,
    test: /\b(garant\w+|assegur\w+|100%|resultado garantido|(êxito|exito|vitória|vitoria|ganho|sucesso) garantid\w+|certeza de (ganho|êxito|exito|vitória|vitoria))\b/i,
    reason: 'Promessa/garantia de resultado é vedada (Prov. 205/2021 Art. 6º).',
    explanation:
      'O Provimento 205/2021 (Art. 6º) proíbe prometer ou garantir resultados. A advocacia é atividade-meio: nenhum profissional pode assegurar o desfecho de um caso, e fazê-lo configura captação e publicidade enganosa.',
    suggestion:
      'Descreva sua atuação, não o resultado. Troque "êxito garantido" por algo como "atuação em recursos e defesas na área X".',
    examplesForbidden: [
      'Resultado 100% garantido no seu processo',
      'Sucesso garantido em ações trabalhistas',
      'Você tem a certeza de ganho da causa',
    ],
    examplesAllowed: [
      'Atuação em ações trabalhistas e previdenciárias',
      'Acompanho cada etapa do processo com transparência',
    ],
  },
  {
    id: 'superlative-comparison',
    category: 'comparison',
    severity: 'block',
    version: POLICY_VERSION,
    // Fronteiras unicode (\p{L}) — necessárias para "único" (ú acentuado no início).
    test: /(?<![\p{L}])((o|a) melhor|n[ºo°]\.? ?1|número um|numero um|imbatív\w+|imbativ\w+|líder de mercado|lider de mercado|referência (nacional|no mercado)|o mais (premiado|renomado|reconhecido)|único (advogad\w*|escritóri\w*))(?![\p{L}])/iu,
    reason: 'Autoengrandecimento / comparação é vedado (Prov. 205/2021 Art. 3º, IV).',
    explanation:
      'O Art. 3º, IV veda expressões de autoengrandecimento e comparação ("o melhor", "nº 1", "líder de mercado"). A comunicação deve ser sóbria e informativa, sem se colocar acima de outros profissionais.',
    suggestion:
      'Substitua superlativos por fatos verificáveis: anos de atuação, áreas, formação. Ex.: "advogada com 12 anos em direito de família".',
    examplesForbidden: [
      'O melhor advogado criminalista da cidade',
      'Escritório nº 1 em direito tributário',
      'Referência nacional em recuperação judicial',
    ],
    examplesAllowed: [
      'Advogado dedicado ao direito criminal',
      'Atuação consolidada em direito tributário',
    ],
  },
  {
    id: 'commercialization',
    category: 'commercialization',
    severity: 'warn',
    version: POLICY_VERSION,
    test: /\b(melhor custo[- ]benefício|melhor custo[- ]beneficio|invista (no seu|em seu) (caso|direito)|não fique no prejuízo|nao fique no prejuizo|garanta já o seu|garanta ja o seu|aproveite (a|essa) oportunidade|vagas limitadas)\b/i,
    reason: 'Linguagem mercadológica/de venda contraria a sobriedade (Prov. 205/2021 Art. 3º, caput).',
    explanation:
      'O caput do Art. 3º exige comunicação informativa e discreta, sem mercantilização. Expressões de venda ("melhor custo-benefício", "invista", "aproveite a oportunidade") tratam o serviço jurídico como produto de consumo.',
    suggestion:
      'Adote um tom informativo. Explique o que você faz e como pode orientar, sem argumentos de venda ou senso de oportunidade.',
    examplesForbidden: [
      'O melhor custo-benefício em assessoria jurídica',
      'Invista no seu direito e não fique no prejuízo',
      'Aproveite a oportunidade, vagas limitadas',
    ],
    examplesAllowed: [
      'Orientação jurídica clara sobre seus direitos',
      'Explico as alternativas possíveis em cada caso',
    ],
  },
  {
    id: 'price-fee',
    category: 'price',
    severity: 'block',
    version: POLICY_VERSION,
    test: /\b(honorári\w+|r\$ ?\d+|valor da consulta|preç\w+|tabela de valores|menor preço)\b/i,
    reason: 'Menção a preços/honorários é vedada (Prov. 205/2021 Art. 3º, I).',
    explanation:
      'O Art. 3º, I proíbe referência a valores, preços e honorários na publicidade. A definição de honorários é matéria reservada à relação contratual com o cliente, não à divulgação.',
    suggestion:
      'Remova qualquer valor. Combine honorários em atendimento reservado, fora do perfil público.',
    examplesForbidden: [
      'Consulta a partir de R$ 200',
      'Honorários acessíveis para todos',
      'Confira nossa tabela de valores',
    ],
    examplesAllowed: [
      'Atendimento mediante agendamento',
      'Entre em contato para conhecer o trabalho',
    ],
  },
  {
    id: 'discount-payment',
    category: 'discount',
    severity: 'block',
    version: POLICY_VERSION,
    test: /\b(desconto|promoç\w+|parcel\w+|liquidaç\w+|condições especiais|aceitamos (cartão|cartao|pix)|forma[s]? de pagamento)\b/i,
    reason: 'Descontos/promoções/formas de pagamento são vedados (Prov. 205/2021 Art. 3º, I).',
    explanation:
      'Ainda no Art. 3º, I, são vedadas menções a descontos, promoções, parcelamento e formas de pagamento — configuram captação mercantil, tratando a advocacia como comércio.',
    suggestion:
      'Retire promoções e condições de pagamento do perfil. Esses temas pertencem ao contrato privado com o cliente.',
    examplesForbidden: [
      'Desconto especial para novos clientes',
      'Parcelamos seus honorários em até 12x',
      'Aceitamos cartão e pix; condições especiais',
    ],
    examplesAllowed: [
      'Atuação em direito do consumidor',
      'Fale comigo para agendar um atendimento',
    ],
  },
  {
    id: 'free-bait',
    category: 'free-bait',
    severity: 'block',
    version: POLICY_VERSION,
    test: /\b(consulta (grátis|gratis|gratuita)|primeira consulta gratuita|de graça|sem custo|análise gratuita|avaliação gratuita)\b/i,
    reason: 'Oferta de serviço gratuito como isca (captação de clientela) é vedada.',
    explanation:
      'Oferecer gratuidade como chamariz ("consulta grátis", "análise gratuita") é captação disfarçada. O trabalho pro bono é legítimo, mas voltado a quem necessita — não como isca para clientes pagantes (CED Art. 30).',
    suggestion:
      'Não anuncie gratuidade como atrativo. Se realiza pro bono, isso é conduzido reservadamente, sem função publicitária.',
    examplesForbidden: [
      'Primeira consulta gratuita, agende já',
      'Faço a análise do seu caso sem custo',
      'Avaliação gratuita do seu processo',
    ],
    examplesAllowed: [
      'Atendo mediante agendamento prévio',
      'Esclareço dúvidas sobre a área de atuação',
    ],
  },
  {
    id: 'cta-hire',
    category: 'cta',
    severity: 'block',
    version: POLICY_VERSION,
    test: /\b(contrate|contrata[- ]?me|contrate agora|clique (aqui|e (agende|contrate))|feche com|feche seu contrato|garanta sua vaga)\b/i,
    reason: 'Chamada direta à contratação (CTA) é captação vedada (CED Art. 46).',
    explanation:
      'O CED (Art. 46) veda insinuações diretas à contratação. Botões e frases de "contrate agora" / "clique e agende" transformam informação em captação ativa de clientela.',
    suggestion:
      'Use rótulos neutros de contato: "Enviar mensagem", "Falar no WhatsApp", "Agendar atendimento" — sem imperativo de contratação.',
    examplesForbidden: [
      'Contrate agora mesmo',
      'Clique aqui e agende sua consulta',
      'Feche seu contrato hoje',
    ],
    examplesAllowed: ['Enviar mensagem', 'Falar no WhatsApp', 'Agendar um atendimento'],
  },
  {
    id: 'oab-symbol',
    category: 'oab-misuse',
    severity: 'block',
    version: POLICY_VERSION,
    test: /\b(selo (oficial )?(da |de |do )?oab|chancela(do)? (pela|da) oab|aprovad\w+ pela oab|logo(tipo)? da oab|símbolo da oab|simbolo da oab|verificad\w+ pela oab|autorizad\w+ pela oab)\b/i,
    reason: 'Uso de selo/símbolo/chancela oficial da OAB é vedado (Prov. 205/2021 Art. 5º, §2º).',
    explanation:
      'O Art. 5º, §2º proíbe usar símbolos, brasão, logotipo ou qualquer expressão que insinue chancela oficial da OAB ("aprovado/verificado pela OAB"). Isso engana o público sobre um endosso institucional inexistente.',
    suggestion:
      'Nunca sugira aval da OAB. A marca informativa correta é "OAB conferida" — conferência feita pela plataforma, sem símbolos oficiais.',
    examplesForbidden: [
      'Advogado aprovado pela OAB',
      'Perfil com selo oficial da OAB',
      'Escritório verificado pela OAB',
    ],
    examplesAllowed: [
      'Inscrito na OAB/SP sob nº 123.456',
      'OAB conferida pela plataforma',
    ],
  },
  {
    id: 'client-case-secrecy',
    category: 'secrecy',
    severity: 'block',
    version: POLICY_VERSION,
    test: /\b(ganhei o caso do|processo do cliente|caso [A-Z]\w+ vs|meu cliente \w+ (ganhou|venceu))\b/i,
    reason: 'Exposição de caso/cliente identificável viola o sigilo profissional.',
    explanation:
      'Divulgar casos concretos ou identificar clientes fere o sigilo profissional (CED Art. 35–38) e a vedação ao uso de casos e resultados (Prov. 205/2021 Art. 5º §3º), mesmo que o desfecho tenha sido favorável.',
    suggestion:
      'Fale das áreas e do tipo de trabalho em termos gerais, sem citar processos, partes ou resultados de casos reais.',
    examplesForbidden: [
      'Ganhei o caso do João contra o banco',
      'Meu cliente Pedro ganhou a ação',
      'No caso Silva vs Estado obtivemos liminar',
    ],
    examplesAllowed: [
      'Atuo em ações contra instituições financeiras',
      'Experiência em demandas cíveis e de consumo',
    ],
  },
  {
    id: 'testimonials-clientlist',
    category: 'testimonial',
    severity: 'block',
    version: POLICY_VERSION,
    test: /\b(depoimentos?|clientes satisfeit\w+|lista de clientes|nossos clientes incluem|trabalhamos com \p{Lu})/iu,
    reason: 'Depoimentos e lista de clientes são vedados (CED Art. 42, IV/V).',
    explanation:
      'O CED (Art. 42, IV e V) proíbe divulgar depoimentos, testemunhos e lista de clientes/demandas. Endossos de terceiros são marketing testimonial e caracterizam captação escamoteada.',
    suggestion:
      'Remova depoimentos e menções a clientes. Demonstre competência pela descrição sóbria das áreas e da experiência.',
    examplesForbidden: [
      'Veja os depoimentos de clientes satisfeitos',
      'Nossos clientes incluem grandes empresas',
      'Trabalhamos com Petrobras e Vale',
    ],
    examplesAllowed: [
      'Atuação para pessoas físicas e empresas',
      'Experiência em contratos empresariais',
    ],
  },
  {
    id: 'paid-ranking',
    category: 'paid-ranking',
    severity: 'warn',
    version: POLICY_VERSION,
    test: /\b(top \d+ advogad|melhores advogados|prêmio (de|melhor)|ranking pago|advogado premiad)/i,
    reason: 'Ranking/prêmio pago é vedado (Prov. 205/2021 Art. 5º, §1º).',
    explanation:
      'O Art. 5º, §1º veda desembolso para figurar em rankings, prêmios ou listas de "melhores advogados". Exibir essas honrarias, quando pagas, é captação indevida.',
    suggestion:
      'Evite citar rankings e prêmios comerciais. Prefira qualificações objetivas (formação, títulos acadêmicos reais).',
    examplesForbidden: [
      'Eleito um dos Top 10 advogados de 2025',
      'Entre os melhores advogados do país',
      'Advogado premiado no ranking do ano',
    ],
    examplesAllowed: ['Especialista em direito empresarial', 'Mestre em direito processual civil'],
  },
  {
    id: 'urgency-appeal',
    category: 'urgency',
    severity: 'warn',
    version: POLICY_VERSION,
    // Fronteiras unicode (\p{L}) em vez de \b: casam corretamente palavras iniciadas
    // por letra acentuada ("Últimas vagas"), que o \b ASCII do JS não reconhece.
    test: /(?<![\p{L}])(fale comigo agora|não perca tempo|nao perca tempo|corra|últimas vagas|ultimas vagas|aproveite (já|agora)|atendimento 24 ?h|agende (já|agora mesmo)|ligue agora)(?![\p{L}])/iu,
    reason: 'Apelo de urgência / captação de clientela — reveja o tom.',
    explanation:
      'Frases de urgência ("não perca tempo", "ligue agora", "últimas vagas") incitam a contratação imediata, contrariando a discrição e sobriedade exigidas (CED Art. 46; Prov. 205/2021 Art. 3º).',
    suggestion:
      'Retire o senso de urgência. Um convite sóbrio ao contato ("estou à disposição para agendar") comunica o mesmo sem pressão.',
    examplesForbidden: [
      'Não perca tempo, ligue agora',
      'Últimas vagas para atendimento',
      'Atendimento 24h, agende já',
    ],
    examplesAllowed: [
      'Estou à disposição para agendar um atendimento',
      'Atendo com horário marcado',
    ],
  },
  {
    id: 'giveaway',
    category: 'giveaway',
    severity: 'warn',
    version: POLICY_VERSION,
    test: /\b(sorteio|brinde grátis|brinde gratis|sorteando|dou de brinde|concurso cultural)\b/i,
    reason: 'Distribuição de brindes/sorteios como isca é vedada (Prov. 205/2021 Art. 3º, V).',
    explanation:
      'O Art. 3º, V veda a distribuição indiscriminada de brindes e o uso de sorteios/concursos como chamariz. É gamificação promocional que disfarça captação de clientela.',
    suggestion:
      'Não use sorteios ou brindes para atrair contatos. Conteúdo educativo gratuito é permitido, desde que sem função de isca.',
    examplesForbidden: [
      'Participe do sorteio de uma consultoria',
      'Estou sorteando brindes para seguidores',
      'Concurso cultural com prêmios',
    ],
    examplesAllowed: [
      'Publico conteúdo educativo sobre direito do trabalho',
      'Compartilho orientações gerais sobre a área',
    ],
  },
]

/**
 * Impressão digital determinística do conjunto de regras (id|categoria|severidade
 * por regra, ordenado + versão + revisão). Usada pela TRAVA DE PARIDADE: os testes
 * de cada pacote recomputam este valor e comparam com docs/oab-ruleset.lock — se
 * front e back divergirem, o lock não bate e o teste falha. Ver oab.rules.spec.ts.
 */
export function computeRulesetFingerprint(rules: Rule[] = RULES): string {
  const body = rules
    .map((r) => `${r.id}|${r.category}|${r.severity}`)
    .sort()
    .join(';')
  return `v=${POLICY_VERSION};rev=${RULESET_REV};n=${rules.length};${body}`
}
