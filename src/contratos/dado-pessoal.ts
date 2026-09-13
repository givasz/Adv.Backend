// O que parece dado pessoal num texto que vai ser GUARDADO.
//
// Serve a uma regra só: o modelo próprio do advogado é texto, e o dado do cliente
// entra a cada documento, no aparelho (ver model ModeloProprio). Esta é a porta
// que impede um modelo de virar, sem ninguém perceber, o arquivo de um cliente.
//
// O QUE ELE PEGA: CPF, CNPJ, e-mail, telefone, CEP, número de processo no padrão
// do CNJ, agência/conta e chave Pix aleatória — dado com FORMA reconhecível.
// O QUE ELE NÃO PEGA, e a tela diz: nome de pessoa. Um nome não tem forma; tentar
// adivinhar barraria "Maria da Penha" numa citação de lei e deixaria passar
// "João Silva". Em vez de fingir, a tela pede para não escrever.
//
// Não pega número de lei, artigo, data, percentual nem valor em reais: nada disso
// identifica ninguém, e um contrato sem "Lei nº 13.105/2015" não existe.
//
// ⚠️ PARIDADE com frontend/src/lib/contratos/dadoPessoal.ts — os dois lados
// passam pelos MESMOS casos (frontend/src/lib/contratos/dadoPessoal.casos.json).
// Se só um lado mudar, a tela aceita e o servidor recusa (ou o contrário).

export type TipoDeDadoPessoal =
  | 'processo'
  | 'cnpj'
  | 'cpf'
  | 'email'
  | 'chave-pix'
  | 'telefone'
  | 'cep'
  | 'conta'

export const ROTULO_DO_DADO: Record<TipoDeDadoPessoal, string> = {
  processo: 'número de processo',
  cnpj: 'CNPJ',
  cpf: 'CPF',
  email: 'e-mail',
  'chave-pix': 'chave Pix',
  telefone: 'telefone',
  cep: 'CEP',
  conta: 'agência ou conta bancária',
}

// A ORDEM importa: o que casa primeiro é apagado do texto antes do padrão
// seguinte, para um número de processo não virar também "CPF" e "telefone".
const PADROES: [TipoDeDadoPessoal, RegExp][] = [
  ['processo', /\b\d{7}-?\d{2}\.?\d{4}\.?\d\.?\d{2}\.?\d{4}\b/g],
  ['cnpj', /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g],
  ['cpf', /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g],
  ['email', /[^\s@<>(){}[\]"',;:]+@[^\s@<>(){}[\]"',;:]+\.[a-z]{2,}/gi],
  ['chave-pix', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi],
  ['telefone', /(?:\+?55[\s.-]?)?(?:\(\d{2}\)|\b\d{2})[\s.-]?9?\d{4}[\s.-]?\d{4}\b/g],
  ['cep', /\b\d{5}-\d{3}\b/g],
  [
    'conta',
    /\b(?:ag[êe]ncia|conta(?:\s+corrente|\s+poupan[çc]a)?|c\/c)\s*(?:n[º°o.]*\s*)?:?\s*\d[\d.-]{2,}\d/gi,
  ],
]

export interface DadoPessoalAchado {
  tipo: TipoDeDadoPessoal
  /** o trecho com os dígitos (ou o nome do e-mail) escondidos — para mostrar ONDE */
  trecho: string
}

/** Esconde o miolo: "529.•••.•••-25", "jo•••@exemplo.com". */
function mascarar(tipo: TipoDeDadoPessoal, s: string): string {
  if (tipo === 'email') {
    const [nome, dominio] = s.split('@')
    return `${(nome ?? '').slice(0, 2)}•••@${dominio ?? ''}`
  }
  let digitos = 0
  const total = (s.match(/\d/g) ?? []).length
  return s.replace(/[0-9a-f]/gi, (ch) => {
    if (!/\d/.test(ch)) return tipo === 'chave-pix' ? '•' : ch
    digitos += 1
    return digitos <= 3 || digitos > total - 2 ? ch : '•'
  })
}

/** Todos os trechos que parecem dado pessoal, na ordem em que aparecem. */
export function acharDadosPessoais(texto: string): DadoPessoalAchado[] {
  let resto = (texto ?? '').normalize('NFC')
  const achados: { pos: number; achado: DadoPessoalAchado }[] = []
  for (const [tipo, padrao] of PADROES) {
    resto = resto.replace(new RegExp(padrao.source, padrao.flags), (m: string, ...args: unknown[]) => {
      const pos = args.find((a): a is number => typeof a === 'number') ?? 0
      achados.push({ pos, achado: { tipo, trecho: mascarar(tipo, m.trim()) } })
      return ' '.repeat(m.length)
    })
  }
  return achados.sort((a, b) => a.pos - b.pos).map((a) => a.achado)
}
