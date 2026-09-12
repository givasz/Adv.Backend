// Fatos que a IA não pode acrescentar a um texto de perfil.
//
// A checagem da OAB (oab/compliance.ts) pega o que é VEDADO dizer — promessa,
// superlativo, preço. Ela não tem como pegar o que é FALSO: "formada pela
// Universidade Estadual de Campinas" é uma frase perfeitamente regular, e é
// mentira se a pessoa estudou em outro lugar.
//
// Medido em 12/09/2026 com o gpt-oss-120b (reserva Groq): para quem informou só
// "PUC-Campinas", o texto voltou com "Universidade Estadual de Campinas" e
// "pós-graduação em Direito do Trabalho". O Gemini, no mesmo pedido, não inventou
// — mas nada garante que continue assim, nem que a reserva de amanhã se comporte.
//
// O perfil sai em nome do advogado, que responde pelo que está escrito (Termos,
// item 3). Um dado inventado pela plataforma e publicado sem ele notar é o pior
// caso possível: informação falsa em publicidade de advocacia.
//
// O que isto faz: procura no rascunho as CATEGORIAS de fato que um modelo costuma
// inventar — instituição, formação, pós, tempo de experiência, seccional da OAB,
// cargo — e confere se cada uma aparece no que o pedido trouxe. O que não aparece
// volta ao laço de reparo como se fosse uma vedação.
//
// O que isto NÃO faz: julgar se o fato informado é verdadeiro (quem informou
// responde por ele) nem pegar toda invenção possível. Área de atuação inventada,
// por exemplo, não tem forma fechada para procurar — contra ela vale a instrução
// do prompt (SO_FATOS_INFORMADOS em ai.service.ts).
//
// ⚠️ Tudo roda sobre texto NORMALIZADO (sem acento, hífens unificados): `\b` e `\w`
// do JavaScript são ASCII, e o modelo escreve "pós‑graduação" com hífen não
// separável (U+2011). Um padrão com acento e hífen comum passaria em silêncio.

/** O que o pedido trouxe — os únicos fatos que o texto pode afirmar. */
export interface DadosDoPedido {
  keywords: string[]
  areaLabel?: string
  name?: string
  city?: string
  areas?: string[]
  currentText?: string
}

/** Trecho do rascunho que afirma um fato que o pedido não trouxe. Mesmo formato que o reparo lê. */
export interface FatoNaoInformado {
  matchedText: string
  reason: string
  suggestion: string
}

/**
 * Onde o texto vai morar:
 *   'perfil' — bio, headline, revisão: texto SOBRE a pessoa, confere tudo;
 *   'area'   — descrição de um ramo do Direito: "faculdade", "universidade" e
 *              "especializada" ali costumam ser assunto (Direito Educacional,
 *              vara especializada), então só entra o que é inequivocamente currículo.
 */
export type Escopo = 'perfil' | 'area'

export function normalizar(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[­‐-―−]/g, '-')
    .replace(/[   ]/g, ' ')
    .toLowerCase()
}

const NUMEROS: Record<string, number> = {
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7,
  oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14,
  quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19, vinte: 20, trinta: 30,
}
const NUM = `(\\d{1,2}|${Object.keys(NUMEROS).join('|')})`

/** "dez anos" no texto e "10 anos" no pedido são o mesmo fato. */
function numeroInformado(n: string, corpus: string): boolean {
  const alvo = /^\d+$/.test(n) ? Number(n) : NUMEROS[n]
  if (new RegExp(`\\b${alvo}\\b`).test(corpus)) return true
  return Object.entries(NUMEROS).some(([p, v]) => v === alvo && new RegExp(`\\b${p}\\b`).test(corpus))
}

// Siglas e nomes curtos de escolas de Direito. Só nome EXATO (`\b` dos dois lados):
// "unip" sem fronteira pegaria "sociedade unipessoal", que está em muita bio.
const INSTITUICOES = [
  'usp', 'unicamp', 'unesp', 'unifesp', 'fgv', 'mackenzie', 'insper', 'ibmec', 'uerj',
  'ufrj', 'uff', 'ufmg', 'ufrgs', 'ufpr', 'ufsc', 'ufba', 'ufpe', 'ufc', 'unb', 'ufu',
  'ufes', 'ufg', 'ufpa', 'ufam', 'ufrn', 'ufpb', 'ufal', 'ufms', 'ufmt', 'ufop', 'ufjf',
  'ufscar', 'uel', 'uem', 'unisinos', 'damasio', 'fadisp', 'fmu', 'unip', 'uninove',
  'estacio', 'unicuritiba', 'uniceub', 'univali', 'unifor', 'ucsal',
]

// Qualquer menção a curso ou escola no que foi informado: basta para "formada" ficar.
const EVIDENCIA_DE_FORMACAO = new RegExp(
  `\\b(formad|graduad|gradua|bacharel|diplomad|universidade|faculdade|pontificia|pos-? ?gradua|especializ|mba|mestr|doutor|puc|${INSTITUICOES.join('|')})`,
)

const EXPERIENCIA = '(?:experiencia|atuacao|advocacia|carreira|pratica|profissao|exercicio|mercado|dedicacao)'

// Cargo/título → onde procurar a mesma coisa no pedido ("perita" e "perícia").
const RAIZES: Array<[RegExp, RegExp]> = [
  [/^(professor|docente)/, /profess|docen/],
  [/^palestr/, /palestr/],
  [/^(co)?autor/, /autor|livro|obra/],
  [/^conselh/, /conselh/],
  [/^pesquis/, /pesquis/],
  [/^perit/, /perit|peric/],
  [/^arbitr/, /arbitr/],
  [/^mediador/, /media/],
  [/^conciliador/, /concilia/],
  [/^membro/, /membro/],
  [/^presidente/, /presiden/],
  [/^diretor/, /diret/],
  [/^coordenador/, /coorden/],
  [/^(premi|homenag)/, /premi|homenag/],
]

interface Detector {
  tipo: string
  /** Sempre com a flag `g`; roda sobre o texto normalizado. */
  padrao: RegExp
  /** Vale também na descrição de uma área. */
  emArea: boolean
  /** true = o trecho pode ficar (foi informado, ou não é alegação de currículo). */
  aceito(m: RegExpMatchArray, corpus: string, texto: string): boolean
}

const DETECTORES: Detector[] = [
  {
    tipo: 'Instituição de ensino',
    padrao: new RegExp(`\\b(puc\\w*|${INSTITUICOES.join('|')})\\b`, 'g'),
    emArea: true,
    aceito: (m, corpus) => new RegExp(`\\b${m[1].startsWith('puc') ? 'puc' : m[1]}`).test(corpus),
  },
  {
    tipo: 'Instituição de ensino',
    padrao: /\b(pontificia universidade catolica|universidade|faculdade|centro universitario|escola superior)\b/g,
    emArea: false,
    aceito: (m, corpus) =>
      m[1] === 'pontificia universidade catolica' ? /\b(puc|pontificia)/.test(corpus) : corpus.includes(m[1]),
  },
  {
    tipo: 'Pós-graduação ou especialização',
    padrao: /\b(pos[- ]?gradua\w*|especializa\w*|especialista|mba|ll\.?m)\b/g,
    emArea: false,
    aceito: (m, corpus) => {
      const t = m[1]
      if (t.startsWith('pos')) return /\bpos[- ]?gradua/.test(corpus)
      if (t.startsWith('especiali')) return /especiali[sz]/.test(corpus)
      if (t === 'mba') return /\bmba\b/.test(corpus)
      return /\bll\.?m\b/.test(corpus)
    },
  },
  {
    tipo: 'Mestrado ou doutorado',
    padrao: /\b(mestrad\w*|mestre|mestra|doutorad\w*|doutora? em|phd|ph\.d)\b/g,
    emArea: true,
    aceito: (m, corpus) => (m[1].startsWith('mestr') ? /mestr/ : /doutor|\bphd\b|ph\.d/).test(corpus),
  },
  {
    tipo: 'Formação',
    padrao: /\b(formad[oa]s?|graduad[oa]s?|bacharel\w*|diplomad[oa]s?)\b/g,
    emArea: false,
    aceito: (m, corpus, texto) =>
      EVIDENCIA_DE_FORMACAO.test(corpus) ||
      // "Formada em Direito" é verdade de todo advogado. Se vier a escola junto,
      // quem a pega é o detector de instituição.
      /^\s+em\s+direito\b/.test(texto.slice((m.index ?? 0) + m[0].length)),
  },
  {
    tipo: 'Tempo de experiência',
    padrao: new RegExp(
      `\\b(?:experiencia\\s+de\\s+)?(?:(?:ha|mais de|quase|cerca de)\\s+){0,2}${NUM}\\s+anos(?:\\s+(?:de|na|no|em)\\s+${EXPERIENCIA})?`,
      'g',
    ),
    emArea: true,
    aceito: (m, corpus) => {
      const s = m[0]
      // "15 anos de contribuição" e "mais de 5 anos de contrato" são assunto. Só é
      // currículo quando fala de tempo DE PROFISSÃO: "há 10 anos", "10 anos de
      // atuação", "experiência de 10 anos".
      const alegacao = /^experiencia/.test(s) || /^ha\s/.test(s) || new RegExp(`${EXPERIENCIA}$`).test(s)
      if (!alegacao) return true
      const n = new RegExp(`${NUM}\\s+anos`).exec(s)?.[1]
      return !!n && numeroInformado(n, corpus)
    },
  },
  {
    tipo: 'Tempo de experiência',
    padrao: /\b(?:atu\w*|advog\w*|exer\w*|trabalh\w*|inscrit\w*|formad\w*)\s+(?:\w+\s+)?desde\s+((?:19|20)\d{2})\b/g,
    emArea: false,
    aceito: (m, corpus) => corpus.includes(m[1]),
  },
  {
    tipo: 'Tempo de experiência',
    padrao: /\b(?:uma|duas|tres|mais de uma|mais de duas|quase duas)\s+decadas?\b/g,
    emArea: true,
    aceito: (_m, corpus) => /decada/.test(corpus),
  },
  {
    tipo: 'Seccional ou número da OAB',
    padrao:
      /\boab\s*(?:[/-]\s*)?(ac|al|am|ap|ba|ce|df|es|go|ma|mg|ms|mt|pa|pb|pe|pi|pr|rj|rn|ro|rr|rs|sc|se|sp|to)\b(?:\s*(?:n[o.º]?\s*)?(\d[\d.]*))?|\bseccional\s+d[aeo]\s+[a-z]+(?:\s+[a-z]+)?/g,
    emArea: true,
    aceito: (m, corpus) => {
      if (m[0].startsWith('seccional')) return /seccional/.test(corpus)
      if (!new RegExp(`\\boab\\s*(?:[/-]\\s*)?${m[1]}\\b`).test(corpus)) return false
      return !m[2] || corpus.replace(/[.\s]/g, '').includes(m[2].replace(/\./g, ''))
    },
  },
  {
    tipo: 'Cargo, título ou prêmio',
    padrao:
      /\b(?:sou|como|atuo como|atua como|atuando como|tambem|e|foi|fui)\s+(?:(?:um|uma|o|a)\s+)?(professor[a]?|docente|palestrante|autor[a]?|coautor[a]?|conselheir[oa]|pesquisador[a]?|perit[oa]|arbitr[oa]|mediador[a]?|conciliador[a]?|membro|presidente|diretor[a]?|coordenador[a]?)\b|\b(premiad[oa]s?|premios?|homenagead[oa]s?)\b/g,
    emArea: false,
    aceito: (m, corpus) => {
      const palavra = m[1] ?? m[2] ?? ''
      const raiz = RAIZES.find(([re]) => re.test(palavra))
      return !!raiz && raiz[1].test(corpus)
    },
  },
]

/**
 * Os trechos do rascunho que afirmam um fato de currículo que o pedido não trouxe.
 * Vazio = nada inventado nas categorias conferidas.
 */
export function fatosNaoInformados(
  texto: string,
  dados: DadosDoPedido,
  escopo: Escopo = 'perfil',
): FatoNaoInformado[] {
  if (!texto) return []
  const original = texto.normalize('NFC')
  const alvo = normalizar(original)
  // A normalização preserva o tamanho de texto em NFC (é → e), e é isso que deixa
  // devolver o trecho como a pessoa o lê. Se algum caractere raro mudar o tamanho,
  // devolve-se o trecho normalizado — feio, mas certo.
  const alinhado = alvo.length === original.length
  const corpus = normalizar(
    [...dados.keywords, ...(dados.areas ?? []), dados.areaLabel, dados.name, dados.city, dados.currentText]
      .filter(Boolean)
      .join('\n'),
  )

  const achados: FatoNaoInformado[] = []
  const ocupados: Array<[number, number]> = []
  for (const d of DETECTORES) {
    if (escopo === 'area' && !d.emArea) continue
    for (const m of alvo.matchAll(d.padrao)) {
      const ini = m.index ?? 0
      const fim = ini + m[0].length
      // "pós-graduada" casa em dois detectores; o reparo precisa ouvir uma vez.
      if (ocupados.some(([a, b]) => ini < b && a < fim)) continue
      if (d.aceito(m, corpus, alvo)) continue
      ocupados.push([ini, fim])
      achados.push({
        matchedText: (alinhado ? original.slice(ini, fim) : m[0]).trim(),
        reason: `${d.tipo} que não veio nos dados informados — a IA não pode acrescentar fatos.`,
        suggestion: 'Remova este trecho sem pôr outro dado no lugar.',
      })
    }
  }
  return achados
}

/**
 * Este item (palavra-chave, área) é currículo, e não tema de atuação?
 * O texto-modelo usa isto para não escrever "com atuação em 10 anos de atuação e PUC-Campinas".
 */
export function pareceFato(item: string): boolean {
  return fatosNaoInformados(item, { keywords: [] }).length > 0
}
