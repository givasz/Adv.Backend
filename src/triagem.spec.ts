import { describe, expect, it } from 'vitest'
import {
  normalizarTriagem,
  perguntasUtilizaveis,
  textosDaTriagem,
  triagemAtiva,
  TRIAGEM_LABEL_MAX,
  TRIAGEM_MAX_OPCOES,
  TRIAGEM_MAX_PERGUNTAS,
  TRIAGEM_OPCAO_MAX,
  type PerguntaDeTriagem,
} from './triagem'

// ⚠️ Espelho de frontend/src/lib/triagem.spec.ts (bloco "o formato do que o
// advogado monta"). O servidor é quem decide o que fica gravado: se ele normalizar
// diferente da tela, o advogado monta uma triagem e reencontra outra.

const PERGUNTAS: PerguntaDeTriagem[] = [
  { id: 'q1', kind: 'escolha', label: 'Qual assunto?', options: ['Família', 'Trabalhista'] },
  { id: 'q2', kind: 'sim-nao', label: 'Já possui processo?' },
  { id: 'q3', kind: 'texto-longo', label: 'Conte brevemente o que aconteceu.' },
]

describe('normalizarTriagem — o que o servidor aceita gravar', () => {
  it('mantém a ordem escrita pelo advogado', () => {
    expect(normalizarTriagem({ enabled: true, questions: PERGUNTAS }).questions.map((q) => q.id)).toEqual([
      'q1',
      'q2',
      'q3',
    ])
    expect(
      normalizarTriagem({ enabled: true, questions: [...PERGUNTAS].reverse() }).questions.map((q) => q.id),
    ).toEqual(['q3', 'q2', 'q1'])
  })

  it('só `enabled: true` liga — ausente, string ou número deixam desligado', () => {
    for (const v of [undefined, null, 'true', 1, {}]) {
      expect(normalizarTriagem({ enabled: v as never, questions: PERGUNTAS }).enabled).toBe(false)
    }
    expect(normalizarTriagem({ enabled: true, questions: PERGUNTAS }).enabled).toBe(true)
  })

  it('guarda a pergunta ainda sem enunciado, e ela não chega à conversa', () => {
    // O advogado acabou de tocar em "+ Adicionar pergunta": o enunciado está
    // vazio porque ele ainda não escreveu. Descartá-la aqui fazia o botão não
    // adicionar nada — o item nascia e morria no mesmo salvamento.
    const { questions } = normalizarTriagem({
      enabled: true,
      questions: [
        { id: 'a', kind: 'texto', label: '  ' },
        { id: 'b', kind: 'arquivo' as never, label: 'Envie um arquivo' },
      ],
    })
    expect(questions).toHaveLength(2)
    expect(questions[0].label).toBe('')
    expect(questions[1].kind).toBe('texto')
    expect(perguntasUtilizaveis(questions).map((q) => q.id)).toEqual(['b'])
  })

  it('o que não é objeto some da lista', () => {
    const { questions } = normalizarTriagem({
      enabled: true,
      questions: [null, 'x', 7, { id: 'a', kind: 'texto', label: 'Vale' }] as never,
    })
    expect(questions).toHaveLength(1)
  })

  it('nome e formato de atendimento entram uma vez só', () => {
    const { questions } = normalizarTriagem({
      enabled: true,
      questions: [
        { id: 'a', kind: 'contato', label: 'Como posso te chamar?' },
        { id: 'b', kind: 'contato', label: 'Nome completo?' },
        { id: 'c', kind: 'atendimento', label: 'Online ou presencial?' },
        { id: 'd', kind: 'atendimento', label: 'Prefere vir aqui?' },
      ],
    })
    expect(questions.map((q) => q.kind)).toEqual(['contato', 'atendimento'])
  })

  it('respeita os tetos de quantidade e de texto', () => {
    const { questions } = normalizarTriagem({
      enabled: true,
      questions: Array.from({ length: 30 }, (_, i) => ({
        id: `q${i}`,
        kind: 'escolha' as const,
        label: 'x'.repeat(400),
        options: Array.from({ length: 40 }, (_, j) => `${j}-${'o'.repeat(90)}`),
      })),
    })
    expect(questions).toHaveLength(TRIAGEM_MAX_PERGUNTAS)
    expect(questions[0].label).toHaveLength(TRIAGEM_LABEL_MAX)
    expect(questions[0].options).toHaveLength(TRIAGEM_MAX_OPCOES)
    expect(questions[0].options!.every((o) => o.length <= TRIAGEM_OPCAO_MAX)).toBe(true)
  })

  it('id forjado é trocado, e nenhum se repete', () => {
    const { questions } = normalizarTriagem({
      enabled: true,
      questions: [
        { id: '../../../etc/passwd', kind: 'texto', label: 'Um' },
        { id: '<script>', kind: 'texto', label: 'Dois' },
        { id: 'q', kind: 'texto', label: 'Três' },
        { id: 'q', kind: 'texto', label: 'Quatro' },
      ],
    })
    expect(questions).toHaveLength(4)
    expect(new Set(questions.map((q) => q.id)).size).toBe(4)
    expect(questions.every((q) => /^[A-Za-z0-9_-]{1,40}$/.test(q.id))).toBe(true)
  })

  it('opções vazias e repetidas somem', () => {
    const { questions } = normalizarTriagem({
      enabled: true,
      questions: [{ id: 'a', kind: 'escolha', label: 'Qual?', options: ['Um', '', 'Um', ' Dois '] }],
    })
    expect(questions[0].options).toEqual(['Um', 'Dois'])
  })

  it('corpo malformado nunca lança — vira triagem vazia e desligada', () => {
    for (const lixo of [null, undefined, 'x', 7, [], { questions: 'nada' }, { questions: [null] }]) {
      expect(normalizarTriagem(lixo)).toEqual({ enabled: false, questions: [] })
    }
  })
})

describe('o que chega a valer de fato', () => {
  it('escolha sem opção fica guardada, mas não entra na conversa', () => {
    const lista: PerguntaDeTriagem[] = [
      { id: 'a', kind: 'escolha', label: 'Sem opção', options: [] },
      { id: 'b', kind: 'texto', label: 'Livre' },
    ]
    expect(perguntasUtilizaveis(lista).map((q) => q.id)).toEqual(['b'])
    expect(triagemAtiva({ enabled: true, questions: [lista[0]] })).toBe(false)
    expect(triagemAtiva({ enabled: true, questions: lista })).toBe(true)
    expect(triagemAtiva({ enabled: false, questions: lista })).toBe(false)
    expect(triagemAtiva(null)).toBe(false)
  })
})

describe('os enunciados são texto público', () => {
  it('enunciado e opções saem para a checagem da OAB', () => {
    expect(textosDaTriagem({ enabled: true, questions: PERGUNTAS })).toEqual([
      'Qual assunto?',
      'Família',
      'Trabalhista',
      'Já possui processo?',
      'Conte brevemente o que aconteceu.',
    ])
  })
})
