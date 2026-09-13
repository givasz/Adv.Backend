import { describe, expect, it } from 'vitest'
import {
  FIM_DA_TRIAGEM,
  normalizarTriagem,
  perguntasAlcancaveis,
  perguntasUtilizaveis,
  proximaPergunta,
  TRIAGEM_MAX_PERGUNTAS,
  type PerguntaDeTriagem,
} from './triagem'

// OS CAMINHOS ENTRE AS PERGUNTAS — e a garantia de que a conversa TERMINA.
//
// A regra é uma só: um destino só vale se aponta para uma pergunta POSTERIOR,
// ou para o fim da triagem. Não é um detector de ciclos, é impossibilidade
// estrutural — o índice só cresce, então a conversa chega ao fim em no máximo
// N passos, para qualquer configuração que alguém consiga gravar.
//
// Este arquivo é a prova disso, e a parte mais valiosa dele é o percurso
// exaustivo lá embaixo: ele monta triagens com destinos SORTEADOS (inclusive
// para trás e para a própria pergunta), normaliza, e percorre TODOS os caminhos
// possíveis. Nenhum pode deixar de terminar.

const q = (
  id: string,
  extra: Partial<PerguntaDeTriagem> = {},
): PerguntaDeTriagem => ({ id, kind: 'texto', label: `Pergunta ${id}`, ...extra })

const escolha = (id: string, ...opcoes: { id: string; texto: string; proxima?: string }[]) =>
  ({ id, kind: 'escolha', label: `Pergunta ${id}`, options: opcoes }) as PerguntaDeTriagem

const normalizar = (questions: PerguntaDeTriagem[]) =>
  normalizarTriagem({ enabled: true, questions }).questions

// ---------------------------------------------------------------------------

describe('um destino só aponta para FRENTE', () => {
  it('para trás é derrubado — é o que impede o círculo', () => {
    const [, segunda] = normalizar([q('a'), q('b', { proxima: 'a' }), q('c')])
    expect(segunda.proxima).toBeUndefined()
  })

  it('para a própria pergunta é derrubado', () => {
    const [primeira] = normalizar([q('a', { proxima: 'a' }), q('b')])
    expect(primeira.proxima).toBeUndefined()
  })

  it('para uma pergunta que não existe é derrubado', () => {
    const [primeira] = normalizar([q('a', { proxima: 'fantasma' }), q('b')])
    expect(primeira.proxima).toBeUndefined()
  })

  it('para frente vale, e o fim da triagem também', () => {
    const [primeira, segunda] = normalizar([
      q('a', { proxima: 'c' }),
      q('b', { proxima: FIM_DA_TRIAGEM }),
      q('c'),
    ])
    expect(primeira.proxima).toBe('c')
    expect(segunda.proxima).toBe(FIM_DA_TRIAGEM)
  })

  it('a mesma regra vale para o caminho de cada RESPOSTA', () => {
    const [primeira] = normalizar([
      escolha(
        'a',
        { id: 'o1', texto: 'Vai para frente', proxima: 'c' },
        { id: 'o2', texto: 'Tenta voltar', proxima: 'a' },
        { id: 'o3', texto: 'Encerra', proxima: FIM_DA_TRIAGEM },
      ),
      q('b'),
      q('c'),
    ])
    expect(primeira.options?.map((o) => o.proxima)).toEqual(['c', undefined, FIM_DA_TRIAGEM])
  })

  it('mover uma pergunta para cima derruba o caminho que virou "para trás"', () => {
    // O advogado desenha "1 → 3", depois arrasta a 3 para o topo. O caminho
    // some, e o roteiro do editor mostra na hora que a conversa voltou a ser em
    // fila. Segurar um destino quebrado seria pior do que perdê-lo.
    const antes = normalizar([q('a', { proxima: 'c' }), q('b'), q('c')])
    expect(antes[0].proxima).toBe('c')
    const depois = normalizar([q('c'), q('a', { proxima: 'c' }), q('b')])
    expect(depois[1].proxima).toBeUndefined()
  })
})

describe('a cascata de quem decide o caminho', () => {
  const perguntas = normalizar([
    escolha(
      'a',
      { id: 'o1', texto: 'Desvia', proxima: 'c' },
      { id: 'o2', texto: 'Segue' },
    ),
    q('b'),
    q('c'),
  ])

  it('a RESPOSTA manda primeiro', () => {
    expect(proximaPergunta(perguntas, 0, 'o1')).toBe(2)
  })

  it('sem caminho na resposta, vale o da PERGUNTA', () => {
    const comCaminhoNaPergunta = normalizar([
      escolha('a', { id: 'o1', texto: 'Qualquer' }),
      q('b'),
      q('c'),
    ])
    comCaminhoNaPergunta[0].proxima = 'c'
    expect(proximaPergunta(comCaminhoNaPergunta, 0, 'o1')).toBe(2)
  })

  it('sem nenhum dos dois, é a próxima da lista', () => {
    expect(proximaPergunta(perguntas, 0, 'o2')).toBe(1)
    expect(proximaPergunta(perguntas, 1)).toBe(2)
  })

  it('a última pergunta encerra a triagem', () => {
    expect(proximaPergunta(perguntas, 2)).toBe(perguntas.length)
    expect(proximaPergunta(perguntas, 99)).toBe(perguntas.length)
  })

  it('múltipla escolha não ramifica: o caminho é sempre o da pergunta', () => {
    const [multipla] = normalizar([
      {
        id: 'a',
        kind: 'multipla',
        label: 'Marque o que se aplica',
        options: [
          { id: 'o1', texto: 'Um', proxima: 'c' },
          { id: 'o2', texto: 'Dois', proxima: FIM_DA_TRIAGEM },
        ],
      },
      q('b'),
      q('c'),
    ])
    expect(multipla.options?.every((o) => o.proxima === undefined)).toBe(true)
  })
})

describe('quem a conversa consegue alcançar', () => {
  it('pergunta que ninguém aponta e que ninguém atravessa fica inalcançável', () => {
    // "Sim" pula a 2 e vai direto para a 3; "Não" também. Ninguém passa pela 2.
    const perguntas = normalizar([
      escolha(
        'a',
        { id: 'sim', texto: 'Sim', proxima: 'c' },
        { id: 'nao', texto: 'Não', proxima: 'c' },
      ),
      q('b'),
      q('c'),
    ])
    const alcancaveis = perguntasAlcancaveis(perguntas)
    expect(alcancaveis.has('a')).toBe(true)
    expect(alcancaveis.has('b')).toBe(false)
    expect(alcancaveis.has('c')).toBe(true)
  })

  it('basta UM caminho passar por ela para ela ser alcançável', () => {
    const perguntas = normalizar([
      escolha(
        'a',
        { id: 'sim', texto: 'Sim', proxima: 'c' },
        { id: 'nao', texto: 'Não' },
      ),
      q('b'),
      q('c'),
    ])
    expect(perguntasAlcancaveis(perguntas).has('b')).toBe(true)
  })

  it('numa triagem em fila, todas são alcançáveis', () => {
    const perguntas = normalizar([q('a'), q('b'), q('c')])
    expect(perguntasAlcancaveis(perguntas).size).toBe(3)
  })

  it('triagem vazia não alcança ninguém, e não quebra', () => {
    expect(perguntasAlcancaveis([]).size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// A PROVA: nenhuma configuração gravável produz conversa infinita.

describe('a conversa SEMPRE termina', () => {
  /** Percorre todos os caminhos possíveis e devolve o maior número de passos. */
  function maiorPercurso(perguntas: PerguntaDeTriagem[]): number {
    const uteis = perguntasUtilizaveis(perguntas)
    let maior = 0
    const andar = (i: number, passos: number) => {
      // O teto é a rede: se a lógica permitisse um ciclo, esta contagem
      // estouraria e o teste falharia em vez de rodar para sempre.
      if (passos > uteis.length + 2) throw new Error('a conversa não terminou')
      if (i >= uteis.length) {
        maior = Math.max(maior, passos)
        return
      }
      const saidas = uteis[i].options?.length
        ? uteis[i].options!.map((o) => proximaPergunta(uteis, i, o.id))
        : [proximaPergunta(uteis, i)]
      for (const j of new Set(saidas)) andar(j, passos + 1)
    }
    if (uteis.length) andar(0, 0)
    return maior
  }

  it('num desenho em fila, o percurso é o número de perguntas', () => {
    expect(maiorPercurso(normalizar([q('a'), q('b'), q('c')]))).toBe(3)
  })

  it('com desvios, o percurso só encurta', () => {
    const perguntas = normalizar([
      escolha(
        'a',
        { id: 'o1', texto: 'Pula tudo', proxima: FIM_DA_TRIAGEM },
        { id: 'o2', texto: 'Segue' },
      ),
      q('b'),
      q('c'),
    ])
    expect(maiorPercurso(perguntas)).toBe(3)
  })

  // O teste que vale por todos: destinos SORTEADOS, inclusive para trás, para a
  // própria pergunta e para ids que não existem. Depois de passar pelo
  // normalizador, nenhum deles pode produzir uma conversa que não termina.
  it('mil triagens com caminhos sorteados terminam todas', () => {
    let semente = 20260913
    const aleatorio = () => {
      // Gerador próprio, determinístico: um teste que falha uma vez em cem
      // execuções e passa nas outras é pior do que teste nenhum.
      semente = (semente * 1103515245 + 12345) % 2147483648
      return semente / 2147483648
    }
    const escolher = <T,>(lista: T[]): T => lista[Math.floor(aleatorio() * lista.length)]

    for (let rodada = 0; rodada < 1000; rodada++) {
      const quantas = 1 + Math.floor(aleatorio() * TRIAGEM_MAX_PERGUNTAS)
      const ids = Array.from({ length: quantas }, (_, i) => `p${i}`)
      // Inclui ids que não existem e o fim da triagem: o sorteio precisa poder
      // produzir qualquer destino que um corpo forjado produziria.
      const destinos = [...ids, FIM_DA_TRIAGEM, 'nao-existe', '']
      const questions: PerguntaDeTriagem[] = ids.map((id) => {
        const comOpcoes = aleatorio() < 0.6
        if (!comOpcoes) {
          const destino = escolher(destinos)
          return q(id, destino ? { proxima: destino } : {})
        }
        const quantasOpcoes = 1 + Math.floor(aleatorio() * 3)
        return escolha(
          id,
          ...Array.from({ length: quantasOpcoes }, (_, j) => {
            const destino = escolher(destinos)
            return {
              id: `${id}-o${j}`,
              texto: `Opção ${j}`,
              ...(destino ? { proxima: destino } : {}),
            }
          }),
        )
      })

      const normalizadas = normalizar(questions)
      // `maiorPercurso` lança se algum caminho não terminar.
      expect(maiorPercurso(normalizadas)).toBeLessThanOrEqual(normalizadas.length)
    }
  })
})
