import { describe, expect, it } from 'vitest'
import {
  condicaoAtendida,
  normalizarTriagem,
  perguntasAlcancaveis,
  perguntasUtilizaveis,
  proximaPergunta,
  TRIAGEM_MAX_PERGUNTAS,
  type OpcaoDeTriagem,
  type PerguntaDeTriagem,
  type RespostasDoCaminho,
  type TipoDePergunta,
} from './triagem'

// AS LIGAÇÕES ENTRE AS PERGUNTAS — e a garantia de que a conversa TERMINA.
//
// ⚠️ Espelho de frontend/src/lib/triagemCaminhos.spec.ts. Os dois lados rodam a
// MESMA prova porque rodam o mesmo código: se um normalizador divergir, é aqui
// que aparece.
//
// A regra é uma só: uma pergunta só pode depender de uma resposta dada ANTES
// dela. A conversa só anda para frente e nunca espera por uma resposta futura —
// não é um detector de ciclos, é impossibilidade estrutural.
//
// A parte mais valiosa deste arquivo é o percurso exaustivo lá embaixo: ele
// monta triagens com ligações SORTEADAS (inclusive para pergunta posterior, para
// a própria pergunta e para ids que não existem), normaliza e percorre TODOS os
// caminhos possíveis. Nenhum pode deixar de terminar, e o aviso de "ninguém chega
// aqui" tem de bater com o que o percurso encontrou.

const q = (id: string, extra: Partial<PerguntaDeTriagem> = {}): PerguntaDeTriagem => ({
  id,
  kind: 'texto',
  label: `Pergunta ${id}`,
  ...extra,
})

const escolha = (
  id: string,
  opcoes: OpcaoDeTriagem[],
  extra: Partial<PerguntaDeTriagem> = {},
): PerguntaDeTriagem => ({ id, kind: 'escolha', label: `Pergunta ${id}`, options: opcoes, ...extra })

const se = (pergunta: string, ...opcoes: string[]): Partial<PerguntaDeTriagem> => ({
  condicao: { pergunta, opcoes },
})

const normalizar = (questions: PerguntaDeTriagem[]) =>
  normalizarTriagem({ enabled: true, questions }).questions

// ---------------------------------------------------------------------------

describe('uma pergunta só depende de pergunta ANTERIOR', () => {
  it('depender de uma pergunta que vem depois é derrubado', () => {
    const [a] = normalizar([q('a', se('b', 'sim')), escolha('b', [{ id: 'sim', texto: 'Sim' }])])
    expect(a.condicao).toBeUndefined()
  })

  it('depender de si mesma é derrubado', () => {
    const [a] = normalizar([escolha('a', [{ id: 'o1', texto: 'Um' }], se('a', 'o1'))])
    expect(a.condicao).toBeUndefined()
  })

  it('depender de uma pergunta que não existe é derrubado', () => {
    const [, b] = normalizar([escolha('a', [{ id: 'o1', texto: 'Um' }]), q('b', se('fantasma', 'o1'))])
    expect(b.condicao).toBeUndefined()
  })

  it('depender de uma pergunta de resposta escrita é derrubado — não há resposta para ligar', () => {
    const [, b] = normalizar([q('a'), q('b', se('a', 'o1'))])
    expect(b.condicao).toBeUndefined()
  })

  it('respostas que não existem saem; sem nenhuma que exista, a condição cai', () => {
    const [, b, c] = normalizar([
      escolha('a', [
        { id: 'o1', texto: 'Um' },
        { id: 'o2', texto: 'Dois' },
      ]),
      q('b', se('a', 'o2', 'fantasma')),
      q('c', se('a', 'fantasma')),
    ])
    expect(b.condicao).toEqual({ pergunta: 'a', opcoes: ['o2'] })
    expect(c.condicao).toBeUndefined()
  })

  it('sim ou não serve de origem, com as respostas fixas', () => {
    const [, b] = normalizar([{ id: 'a', kind: 'sim-nao', label: 'Já tem processo?' }, q('b', se('a', 'sim'))])
    expect(b.condicao).toEqual({ pergunta: 'a', opcoes: ['sim'] })
  })

  it('subir a pergunta acima daquela de que depende solta a ligação', () => {
    const antes = normalizar([escolha('a', [{ id: 'o1', texto: 'Um' }]), q('b', se('a', 'o1'))])
    expect(antes[1].condicao).toBeDefined()
    const depois = normalizar([q('b', se('a', 'o1')), escolha('a', [{ id: 'o1', texto: 'Um' }])])
    expect(depois[0].condicao).toBeUndefined()
  })

  it('forma torta não quebra e não vira condição', () => {
    for (const torta of ['a', 3, null, [], { pergunta: 3 }, { pergunta: 'a b', opcoes: ['o1'] }, { pergunta: 'a', opcoes: 'o1' }]) {
      const [, b] = normalizar([
        escolha('a', [{ id: 'o1', texto: 'Um' }]),
        { ...q('b'), condicao: torta } as unknown as PerguntaDeTriagem,
      ])
      expect(b.condicao).toBeUndefined()
    }
  })
})

describe('as perguntas que o assistente faz sozinho, tiradas pelo advogado', () => {
  const semEtapas = (raw: unknown) =>
    normalizarTriagem({ enabled: true, questions: [], semEtapas: raw }).semEtapas

  it('só dia e horário, formato e nome saem — sem repetição, na ordem da conversa', () => {
    expect(semEtapas(['nome', 'abertura', 'envio', 'horario', 'nome', 3])).toEqual(['horario', 'nome'])
  })

  it('nada tirado, e o campo nem aparece', () => {
    for (const raw of [undefined, [], 'nome', { nome: true }]) {
      expect(normalizarTriagem({ enabled: true, questions: [], semEtapas: raw })).not.toHaveProperty('semEtapas')
    }
  })
})

describe('encerrar a triagem numa resposta', () => {
  it('só vale o verdadeiro de verdade', () => {
    const [a] = normalizar([
      escolha('a', [
        { id: 'o1', texto: 'Um', encerra: true },
        { id: 'o2', texto: 'Dois', encerra: 'sim' } as unknown as OpcaoDeTriagem,
      ]),
    ])
    expect(a.options?.map((o) => o.encerra)).toEqual([true, undefined])
  })

  it('múltipla escolha não encerra', () => {
    const [a] = normalizar([
      { id: 'a', kind: 'multipla', label: 'Marque', options: [{ id: 'o1', texto: 'Um', encerra: true }] },
    ])
    expect(a.options?.[0].encerra).toBeUndefined()
  })

  it('sim ou não guarda qual resposta encerra', () => {
    const [a] = normalizar([
      { id: 'a', kind: 'sim-nao', label: 'Já resolveu?', options: [{ id: 'sim', texto: 'x', encerra: true }] },
    ])
    expect(a.options).toEqual([
      { id: 'sim', texto: 'Sim', encerra: true },
      { id: 'nao', texto: 'Não' },
    ])
  })
})

describe('o caminho da conversa', () => {
  const perguntas = normalizar([
    escolha('assunto', [
      { id: 'fam', texto: 'Família' },
      { id: 'trab', texto: 'Trabalhista' },
      { id: 'ja', texto: 'Já sei o que preciso', encerra: true },
    ]),
    q('filhos', se('assunto', 'fam')),
    q('emprego', se('assunto', 'trab')),
    q('relato'),
  ])

  it('começa pela primeira', () => {
    expect(proximaPergunta(perguntas, -1)).toBe(0)
  })

  it('quem responde Família recebe a pergunta de Família, e não a de Trabalho', () => {
    const r: RespostasDoCaminho = { assunto: ['fam'] }
    expect(proximaPergunta(perguntas, 0, r)).toBe(1)
    expect(proximaPergunta(perguntas, 1, { ...r, filhos: [] })).toBe(3)
  })

  it('quem responde Trabalhista pula a de Família', () => {
    expect(proximaPergunta(perguntas, 0, { assunto: ['trab'] })).toBe(2)
  })

  it('a resposta que encerra termina a triagem ali', () => {
    expect(proximaPergunta(perguntas, 0, { assunto: ['ja'] })).toBe(perguntas.length)
  })

  it('pergunta pulada não abre nada', () => {
    expect(proximaPergunta(perguntas, 0, {})).toBe(3)
  })

  it('fora da lista, acabou', () => {
    expect(proximaPergunta(perguntas, 3, {})).toBe(perguntas.length)
    expect(proximaPergunta(perguntas, 99, {})).toBe(perguntas.length)
  })

  it('numa múltipla escolha, basta UMA das marcadas abrir', () => {
    const lista = normalizar([
      {
        id: 'm',
        kind: 'multipla',
        label: 'Marque',
        options: [
          { id: 'a', texto: 'A' },
          { id: 'b', texto: 'B' },
        ],
      },
      q('soB', se('m', 'b')),
    ])
    expect(proximaPergunta(lista, 0, { m: ['a'] })).toBe(lista.length)
    expect(proximaPergunta(lista, 0, { m: ['a', 'b'] })).toBe(1)
  })

  it('múltipla escolha com "encerra" forjado não encerra', () => {
    const forjada: PerguntaDeTriagem[] = [
      { id: 'm', kind: 'multipla', label: 'Marque', options: [{ id: 'a', texto: 'A', encerra: true }] },
      q('depois'),
    ]
    expect(proximaPergunta(forjada, 0, { m: ['a'] })).toBe(1)
  })

  it('pergunta que depende de outra dependente só abre com as duas respostas', () => {
    const lista = normalizar([
      escolha('assunto', [
        { id: 'trab', texto: 'Trabalhista' },
        { id: 'outro', texto: 'Outro' },
      ]),
      { id: 'ainda', kind: 'sim-nao', label: 'Ainda trabalha lá?', ...se('assunto', 'trab') },
      q('desde', se('ainda', 'sim')),
      q('fim'),
    ])
    expect(proximaPergunta(lista, 1, { assunto: ['trab'], ainda: ['sim'] })).toBe(2)
    expect(proximaPergunta(lista, 1, { assunto: ['trab'], ainda: ['nao'] })).toBe(3)
    expect(proximaPergunta(lista, 0, { assunto: ['outro'] })).toBe(3)
  })

  it('sem condição, a pergunta é para todos', () => {
    expect(condicaoAtendida(q('x'), {})).toBe(true)
  })
})

describe('as perguntas que a conversa usa', () => {
  it('a que depende de uma pergunta incompleta sai de cena junto com ela', () => {
    const lista = normalizar([
      escolha('a', [{ id: 'o1', texto: 'Um' }], { label: '' }),
      q('b', se('a', 'o1')),
      q('c'),
    ])
    expect(lista[1].condicao).toBeDefined()
    expect(perguntasUtilizaveis(lista).map((x) => x.id)).toEqual(['c'])
  })
})

describe('quem a conversa consegue alcançar', () => {
  it('a que só abre com uma resposta que encerra é inalcançável', () => {
    const lista = normalizar([
      escolha('a', [
        { id: 'fim', texto: 'Encerra', encerra: true },
        { id: 'segue', texto: 'Segue' },
      ]),
      q('b', se('a', 'fim')),
      q('c', se('a', 'segue')),
    ])
    const alcancaveis = perguntasAlcancaveis(lista)
    expect(alcancaveis.has('b')).toBe(false)
    expect(alcancaveis.has('c')).toBe(true)
  })

  it('depois de uma pergunta em que TODA resposta encerra, ninguém chega', () => {
    const lista = normalizar([
      escolha('a', [
        { id: 'o1', texto: 'Um', encerra: true },
        { id: 'o2', texto: 'Dois', encerra: true },
      ]),
      q('b'),
    ])
    expect(perguntasAlcancaveis(lista).has('b')).toBe(false)
  })

  it('… a menos que dê para pular aquela pergunta', () => {
    const lista = normalizar([
      escolha('a', [{ id: 'o1', texto: 'Um', encerra: true }], { optional: true }),
      q('b'),
    ])
    expect(perguntasAlcancaveis(lista).has('b')).toBe(true)
  })

  it('numa triagem em fila, todas são alcançáveis', () => {
    expect(perguntasAlcancaveis(normalizar([q('a'), q('b'), q('c')])).size).toBe(3)
  })

  it('triagem vazia não alcança ninguém, e não quebra', () => {
    expect(perguntasAlcancaveis([]).size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// A PROVA: nenhuma configuração gravável produz conversa infinita, e o aviso de
// pergunta inalcançável diz a verdade.

describe('a conversa SEMPRE termina', () => {
  /** Percorre TODOS os caminhos — múltipla escolha com todas as combinações. */
  function percorrer(perguntas: PerguntaDeTriagem[]) {
    const uteis = perguntasUtilizaveis(perguntas)
    const visitadas = new Set<string>()
    let maior = 0
    const andar = (i: number, passos: number, respostas: RespostasDoCaminho): void => {
      if (passos > uteis.length) throw new Error('a conversa não terminou')
      if (i >= uteis.length) {
        maior = Math.max(maior, passos)
        return
      }
      const atual = uteis[i]
      visitadas.add(atual.id)
      const opcoes = atual.options ?? []
      const saidas: RespostasDoCaminho[] = []
      if (!opcoes.length) saidas.push({ ...respostas, [atual.id]: [] })
      else if (atual.kind === 'multipla') {
        for (let m = 1; m < 1 << opcoes.length; m++) {
          saidas.push({ ...respostas, [atual.id]: opcoes.filter((_, k) => m & (1 << k)).map((o) => o.id) })
        }
      } else for (const o of opcoes) saidas.push({ ...respostas, [atual.id]: [o.id] })
      if (atual.optional) saidas.push(respostas)
      for (const r of saidas) {
        const j = proximaPergunta(uteis, i, r)
        // O teto é a rede: se a lógica deixasse voltar, isto falharia em vez de
        // rodar para sempre.
        if (j <= i) throw new Error('a conversa andou para trás')
        andar(j, passos + 1, r)
      }
    }
    if (uteis.length) andar(proximaPergunta(uteis, -1), 0, {})
    return { maior, visitadas }
  }

  it('num desenho em fila, o percurso é o número de perguntas', () => {
    expect(percorrer(normalizar([q('a'), q('b'), q('c')])).maior).toBe(3)
  })

  // O teste que vale por todos: ligações SORTEADAS, inclusive para pergunta
  // posterior, para a própria pergunta e para ids que não existem. Depois do
  // normalizador, nenhuma pode produzir uma conversa que não termina — e o
  // conjunto de perguntas alcançáveis tem de ser exatamente o que o percurso achou.
  it('mil triagens com ligações sorteadas terminam todas, e o aviso bate', () => {
    let semente = 20260913
    const aleatorio = () => {
      // Gerador próprio, determinístico: um teste que falha uma vez em cem
      // execuções e passa nas outras é pior do que teste nenhum.
      semente = (semente * 1103515245 + 12345) % 2147483648
      return semente / 2147483648
    }
    const escolher = <T,>(lista: T[]): T => lista[Math.floor(aleatorio() * lista.length)]
    const TIPOS: TipoDePergunta[] = ['escolha', 'escolha', 'escolha', 'multipla', 'sim-nao', 'texto', 'texto']

    for (let rodada = 0; rodada < 1000; rodada++) {
      const quantas = 1 + Math.floor(aleatorio() * TRIAGEM_MAX_PERGUNTAS)
      const ids = Array.from({ length: quantas }, (_, i) => `p${i}`)
      const idsDeOpcao = ids.flatMap((id) => [`${id}-o0`, `${id}-o1`, `${id}-o2`]).concat('sim', 'nao', 'fantasma')
      const questions: PerguntaDeTriagem[] = ids.map((id) => {
        const kind = escolher(TIPOS)
        const pergunta: PerguntaDeTriagem = { id, kind, label: aleatorio() < 0.05 ? '' : `Pergunta ${id}` }
        if (kind === 'escolha' || kind === 'multipla') {
          pergunta.options = Array.from({ length: 1 + Math.floor(aleatorio() * 3) }, (_, j) => ({
            id: `${id}-o${j}`,
            texto: `Opção ${j}`,
            ...(aleatorio() < 0.2 ? { encerra: true as const } : {}),
          }))
        }
        if (kind === 'sim-nao' && aleatorio() < 0.3) {
          pergunta.options = [{ id: escolher(['sim', 'nao']), texto: 'x', encerra: true }]
        }
        if (aleatorio() < 0.2) pergunta.optional = true
        if (aleatorio() < 0.5) {
          pergunta.condicao = {
            pergunta: escolher([...ids, 'nao-existe']),
            opcoes: Array.from({ length: 1 + Math.floor(aleatorio() * 2) }, () => escolher(idsDeOpcao)),
          }
        }
        return pergunta
      })

      const normalizadas = normalizar(questions)
      const { maior, visitadas } = percorrer(normalizadas)
      expect(maior).toBeLessThanOrEqual(perguntasUtilizaveis(normalizadas).length)
      expect([...perguntasAlcancaveis(normalizadas)].sort()).toEqual([...visitadas].sort())
    }
  })
})
