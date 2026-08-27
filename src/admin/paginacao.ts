// Paginação das listas do painel.
//
// O problema que ela resolve não é performance — é honestidade. As quatro listas
// do painel cortavam **em silêncio**: a busca de advogados devolvia 50 e nada
// dizia que havia um 51º; os chamados paravam em 200; e a fila de denúncias não
// cortava nada, carregando toda denúncia já feita para agrupar em memória.
//
// Uma lista truncada sem aviso lê-se como "é só isso que existe". Num painel que
// decide o que sai do ar, isso é pior do que lento: é errado. Daí toda resposta
// dizer quantos itens existem ao todo e se há mais.
//
// Dois formatos, e a escolha entre eles não é gosto:
//
//   • **Por deslocamento** (`Pagina`) para o que se consulta e se conta — busca,
//     denúncias, chamados. Devolve o total, que é o que permite escrever
//     "25 de 140" na tela.
//   • **Por cursor** (`Trilha`) para o histórico, que é append-only e recebe
//     linha nova no topo o tempo todo. Com deslocamento, uma linha que chegasse
//     entre um "carregar mais" e o seguinte empurraria a lista e faria a página
//     seguinte repetir o que já estava na tela — numa trilha de auditoria, ver a
//     mesma decisão duas vezes é um defeito sério. E `COUNT(*)` numa tabela que
//     só cresce é caro para uma informação que ninguém lê.

/** Uma fatia de lista que sabe de que tamanho é o todo. */
export interface Pagina<T> {
  itens: T[]
  /** Quantos existem ao todo com este filtro. */
  total: number
  offset: number
  limite: number
  /** Há mais depois desta fatia? */
  temMais: boolean
}

/** Uma fatia de trilha: sem total, com o ponto de onde continuar. */
export interface Trilha<T> {
  itens: T[]
  /** Id do último item — passe de volta como `cursor` para pegar a próxima fatia. */
  proximo: string | null
  temMais: boolean
}

const PADRAO = 25
const TETO = 100

/**
 * Traduz o que veio na URL em `take`/`skip`.
 *
 * O teto existe para que um `?limite=999999` não vire um jeito de pedir a tabela
 * inteira — o mesmo motivo pelo qual as listas já tinham um corte fixo. A
 * diferença é que agora o corte é dito em voz alta.
 */
export function faixa(
  limite?: unknown,
  offset?: unknown,
  padrao = PADRAO,
  teto = TETO,
): { take: number; skip: number } {
  const n = Number(limite)
  const take = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), teto) : padrao
  const o = Number(offset)
  const skip = Number.isFinite(o) && o > 0 ? Math.floor(o) : 0
  return { take, skip }
}

/** Monta a resposta paginada a partir do que o banco devolveu. */
export function pagina<T>(itens: T[], total: number, take: number, skip: number): Pagina<T> {
  return {
    itens,
    total,
    offset: skip,
    limite: take,
    temMais: skip + itens.length < total,
  }
}

/**
 * Quantos itens pedir ao banco numa consulta por cursor.
 *
 * Pede-se **um a mais** do que se vai mostrar: se ele vier, é porque há mais —
 * e descobrir isso assim custa uma linha, contra um `COUNT(*)` na tabela toda.
 */
export function faixaTrilha(limite?: unknown, padrao = 50, teto = 200): number {
  const n = Number(limite)
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), teto) : padrao
}

/** Monta a resposta por cursor a partir das `take + 1` linhas pedidas. */
export function trilha<T extends { id: string }>(linhas: T[], take: number): Trilha<T> {
  const temMais = linhas.length > take
  const itens = temMais ? linhas.slice(0, take) : linhas
  return { itens, proximo: itens.length ? itens[itens.length - 1]!.id : null, temMais }
}
