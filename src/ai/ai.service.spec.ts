// O tamanho do texto que a IA devolve.
//
// Dois defeitos reais motivaram estes testes, e os dois eram invisíveis: o texto
// voltava plausível, só que grande demais para o campo. Quem gerasse pelo editor
// não percebia (o `maxLength` do campo na tela segurava); quem chegasse por
// qualquer outro caminho gravaria um texto que o save recusa.
//
//   1. `dto.maxChars ?? FAQ_ANSWER_MAX` — `maxChars` ausente vale ZERO, e
//      `0 ?? 220` é 0. O prompt mandava a IA escrever "no máximo 0 caracteres".
//   2. Sem `maxChars`, o corte pós-geração recebia 0, que significa "não corte".
//      Medido contra a API: 314 caracteres num campo de 220.

import { describe, expect, it } from 'vitest'
import { AiService } from './ai.service'
import { FAQ_ANSWER_MAX } from '../plans'

// O teto do FAQ virou tabela por plano em 04/09/2026. Sem plano declarado no
// pedido, o servidor usa o MAIOR — apertar por conta própria encurtaria a
// resposta de um Max sem ninguém ter pedido. Quem sabe o plano é o editor.
const TETO_FAQ = Math.max(...Object.values(FAQ_ANSWER_MAX))

// `sanitizeDto`, `buildPrompt` e `fitToLimit` são privados — e devem continuar
// sendo. O teste alcança o comportamento pelo tipo, sem afrouxar a classe.
const interno = (s: AiService) =>
  s as unknown as {
    sanitizeDto(d: unknown): { kind: string; maxChars: number }
    buildPrompt(dto: unknown): string
    fitToLimit(texto: string, limite: number): string
  }

function servico() {
  return interno(new AiService())
}

describe('teto de caracteres do FAQ', () => {
  it('respeita o teto que o front declara', () => {
    const dto = servico().sanitizeDto({ kind: 'faq', maxChars: 180 })
    expect(dto.maxChars).toBe(180)
  })

  it('sem teto declarado, usa o do campo — nunca zero', () => {
    const dto = servico().sanitizeDto({ kind: 'faq' })
    expect(dto.maxChars).toBe(TETO_FAQ)
    expect(dto.maxChars).toBeGreaterThan(0)
  })

  it('teto inválido não vira zero num campo que tem tamanho conhecido', () => {
    for (const ruim of [0, -5, 'muito', null, NaN, undefined]) {
      const dto = servico().sanitizeDto({ kind: 'faq', maxChars: ruim })
      expect(dto.maxChars).toBe(TETO_FAQ)
    }
  })
})

describe('a IA é INSTRUÍDA com o limite', () => {
  it('o prompt do FAQ cita o número de caracteres', () => {
    const s = servico()
    const prompt = s.buildPrompt(s.sanitizeDto({ kind: 'faq', maxChars: 220 }))
    expect(prompt).toContain('220 caracteres')
  })

  it('sem maxChars, o prompt cita o teto do campo — e nunca "0 caracteres"', () => {
    const s = servico()
    const prompt = s.buildPrompt(s.sanitizeDto({ kind: 'faq' }))
    expect(prompt).toContain(`${TETO_FAQ} caracteres`)
    // A frase exata do bug. Não dá para procurar só "0 caracteres": "220
    // caracteres" contém essa sequência, e o teste passaria sempre.
    expect(prompt).not.toMatch(/máximo 0 caracteres/)
  })

  // O teto sozinho fazia o modelo escrever até encostar nele. A resposta saía com
  // cinco linhas no celular — a parede de texto que o FAQ existe para evitar.
  it('o prompt pede para ficar ABAIXO do teto, não em cima dele', () => {
    const s = servico()
    const prompt = s.buildPrompt(s.sanitizeDto({ kind: 'faq', maxChars: 220 }))
    expect(prompt).toMatch(/ABAIXO/)
    expect(prompt).toMatch(/2 ou 3 frases/)
  })
})

describe('o corte pós-geração nunca devolve mais do que cabe', () => {
  const s = servico()

  it('corta na última frase completa', () => {
    const texto = 'Primeira frase completa. Segunda frase completa. ' + 'x'.repeat(300)
    const r = s.fitToLimit(texto, 220)
    expect(r.length).toBeLessThanOrEqual(220)
    expect(r.endsWith('.')).toBe(true)
  })

  it('sem frase completa, corta na última palavra — não no meio dela', () => {
    const r = s.fitToLimit('palavra '.repeat(100), 220)
    expect(r.length).toBeLessThanOrEqual(220)
    expect(r.endsWith('palavra')).toBe(true)
  })

  it('texto que já cabe volta inteiro', () => {
    expect(s.fitToLimit('Resposta curta.', 220)).toBe('Resposta curta.')
  })

  it('limite 0 significa "não corte" — e por isso o FAQ nunca chega aqui com 0', () => {
    const longo = 'x'.repeat(400)
    expect(s.fitToLimit(longo, 0)).toHaveLength(400)
    // A trava que impede o 0 de alcançar o FAQ está em sanitizeDto, testada acima.
    expect(servico().sanitizeDto({ kind: 'faq' }).maxChars).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// O plano B da cadeia de IA (04/09/2026).
//
// Produção roda em tier grátis, e tier grátis cai: cota, 503, rede. A cadeia
// tem de ser um PLANO B (um por vez, na ordem), com uma tentativa de conserto
// antes de passar a vez, e sem cobrar a mesma falha de todo pedido seguinte.
// `chamarProvedor` é privado e continua sendo — o teste o substitui pelo tipo.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, vi } from 'vitest'
import {
  DESCANSO_LENTO_MS,
  DESCANSO_MS,
  ErroDeProvedor,
  MINIMO_PARA_TENTAR_MS,
  PRAZO_DO_PEDIDO_MS,
  TEMPO_POR_CHAMADA_MS,
  type Provider,
} from './provedores'

type Resposta = string | ErroDeProvedor
type Roteiro = Partial<Record<Provider, Resposta[]>>

/** Monta um serviço cujos provedores respondem pelo roteiro; devolve o rastro de chamadas. */
function cadeiaDeMentira(roteiro: Roteiro) {
  const s = new AiService()
  const chamadas: Array<`${Provider}:${string}`> = []
  const fila: Roteiro = Object.fromEntries(Object.entries(roteiro).map(([k, v]) => [k, [...v]]))
  ;(s as unknown as { chamarProvedor: unknown }).chamarProvedor = async (
    provedor: Provider,
    _modelo: string,
    chave: string,
  ) => {
    chamadas.push(`${provedor}:${chave}`)
    const proxima = fila[provedor]?.shift()
    if (proxima === undefined) throw new Error(`roteiro acabou para ${provedor}`)
    if (proxima instanceof ErroDeProvedor) throw proxima
    return proxima
  }
  s.pausa = async () => {}
  const runModel = (
    s as unknown as { runModel(p: string, n: number, prazo: number): Promise<string> }
  ).runModel
  return {
    gerar: (prazo = Date.now() + PRAZO_DO_PEDIDO_MS) => runModel.call(s, 'prompt', 100, prazo),
    chamadas,
  }
}

const erro = (p: Provider, status: number, motivo: string) => new ErroDeProvedor(p, status, motivo)

describe('a cadeia é um plano B, não uma corrida', () => {
  const ENV_ANTES = { ...process.env }
  beforeEach(() => {
    process.env.AI_PROVIDER = 'gemini,groq'
    process.env.GEMINI_API_KEY = 'g1'
    process.env.GROQ_API_KEY = 'q1'
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-04T12:00:00Z'))
  })
  afterEach(() => {
    process.env = { ...ENV_ANTES }
    vi.useRealTimers()
  })

  it('o principal respondeu: a reserva nem é chamada', async () => {
    const c = cadeiaDeMentira({ gemini: ['texto do gemini'], groq: ['texto do groq'] })
    await expect(c.gerar()).resolves.toBe('texto do gemini')
    expect(c.chamadas).toEqual(['gemini:g1'])
  })

  it('falha passageira (503): repete UMA vez no mesmo provedor antes de passar a vez', async () => {
    const c = cadeiaDeMentira({
      gemini: [erro('gemini', 503, 'respondeu 503'), 'gemini se recuperou'],
      groq: ['texto do groq'],
    })
    await expect(c.gerar()).resolves.toBe('gemini se recuperou')
    expect(c.chamadas).toEqual(['gemini:g1', 'gemini:g1'])
  })

  it('duas falhas seguidas: aí sim a reserva assume, na ordem', async () => {
    const c = cadeiaDeMentira({
      gemini: [erro('gemini', 503, 'respondeu 503'), erro('gemini', 502, 'respondeu 502')],
      groq: ['texto do groq'],
    })
    await expect(c.gerar()).resolves.toBe('texto do groq')
    expect(c.chamadas).toEqual(['gemini:g1', 'gemini:g1', 'groq:q1'])
  })

  it('tempo esgotado NÃO é repetido — já foram 20 s, o plano B entra direto', async () => {
    const c = cadeiaDeMentira({
      gemini: [erro('gemini', 0, 'tempo esgotado (20 s)')],
      groq: ['texto do groq'],
    })
    await expect(c.gerar()).resolves.toBe('texto do groq')
    expect(c.chamadas).toEqual(['gemini:g1', 'groq:q1'])
  })

  it('cota estourada roda as chaves do MESMO provedor, e só depois vai à reserva', async () => {
    process.env.GEMINI_API_KEY = 'g1,g2'
    const c = cadeiaDeMentira({
      gemini: [erro('gemini', 429, 'quota'), erro('gemini', 429, 'quota')],
      groq: ['texto do groq'],
    })
    await expect(c.gerar()).resolves.toBe('texto do groq')
    expect(c.chamadas).toEqual(['gemini:g1', 'gemini:g2', 'groq:q1'])
  })

  it('quem falhou descansa: o pedido seguinte vai direto à reserva, sem pagar a falha de novo', async () => {
    const c = cadeiaDeMentira({
      gemini: [erro('gemini', 503, 'x'), erro('gemini', 503, 'x'), 'gemini voltou'],
      groq: ['groq 1', 'groq 2'],
    })
    await expect(c.gerar()).resolves.toBe('groq 1')
    // Segundo pedido, dentro do prazo: gemini nem é tentado.
    await expect(c.gerar()).resolves.toBe('groq 2')
    expect(c.chamadas).toEqual(['gemini:g1', 'gemini:g1', 'groq:q1', 'groq:q1'])
  })

  it('vencido o descanso, o principal é sondado e retoma o posto sozinho', async () => {
    const c = cadeiaDeMentira({
      gemini: [erro('gemini', 503, 'x'), erro('gemini', 503, 'x'), 'gemini voltou'],
      groq: ['groq 1'],
    })
    await expect(c.gerar()).resolves.toBe('groq 1')
    vi.setSystemTime(Date.now() + DESCANSO_MS)
    await expect(c.gerar()).resolves.toBe('gemini voltou')
    expect(c.chamadas[c.chamadas.length - 1]).toBe('gemini:g1')
  })

  it('tempo esgotado descansa mais tempo que uma falha comum', async () => {
    const c = cadeiaDeMentira({
      gemini: [erro('gemini', 0, 'tempo esgotado (20 s)'), 'gemini voltou'],
      groq: ['groq 1', 'groq 2', 'groq 3'],
    })
    await expect(c.gerar()).resolves.toBe('groq 1')
    vi.setSystemTime(Date.now() + DESCANSO_MS)
    await expect(c.gerar()).resolves.toBe('groq 2') // ainda descansando
    vi.setSystemTime(Date.now() + DESCANSO_LENTO_MS)
    await expect(c.gerar()).resolves.toBe('gemini voltou')
  })

  it('com TODOS descansando, tenta mesmo assim — melhor que desistir sem pedir', async () => {
    const c = cadeiaDeMentira({
      gemini: [erro('gemini', 0, 'tempo esgotado (20 s)'), 'gemini voltou'],
      groq: [erro('groq', 0, 'tempo esgotado (20 s)')],
    })
    await expect(c.gerar()).rejects.toBeInstanceOf(ErroDeProvedor)
    await expect(c.gerar()).resolves.toBe('gemini voltou')
  })
})

// O proxy do Netlify corta em 26 s. O que não couber no orçamento do pedido não
// é resposta lenta — é erro de gateway na tela do advogado.
describe('o orçamento de tempo do pedido', () => {
  const ENV_ANTES = { ...process.env }
  beforeEach(() => {
    process.env.AI_PROVIDER = 'gemini,groq'
    process.env.GEMINI_API_KEY = 'g1'
    process.env.GROQ_API_KEY = 'q1'
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-04T12:00:00Z'))
  })
  afterEach(() => {
    process.env = { ...ENV_ANTES }
    vi.useRealTimers()
  })

  it('cabe no corte do proxy: uma chamada + a reserva ficam abaixo de 26 s', () => {
    expect(PRAZO_DO_PEDIDO_MS).toBeLessThan(26_000)
    expect(TEMPO_POR_CHAMADA_MS * 2).toBeLessThanOrEqual(PRAZO_DO_PEDIDO_MS + 2_000)
    expect(TEMPO_POR_CHAMADA_MS).toBeGreaterThanOrEqual(8_000)
  })

  it('com o prazo quase vencido, nem chama — e o provedor NÃO descansa por isso', async () => {
    const c = cadeiaDeMentira({ gemini: ['gemini ok'], groq: ['groq ok'] })
    await expect(c.gerar(Date.now() + MINIMO_PARA_TENTAR_MS - 1)).rejects.toBeInstanceOf(
      ErroDeProvedor,
    )
    expect(c.chamadas).toEqual([])
    // Pedido seguinte, com prazo cheio: o gemini está lá, de pé.
    await expect(c.gerar()).resolves.toBe('gemini ok')
    expect(c.chamadas).toEqual(['gemini:g1'])
  })

  it('sem tempo para a pausa da repetição, passa a vez em vez de repetir', async () => {
    const c = cadeiaDeMentira({
      gemini: [erro('gemini', 503, 'x'), 'gemini se recuperou'],
      groq: ['groq ok'],
    })
    // Sobra pouco: dá para UMA chamada, não para pausa + chamada.
    await expect(c.gerar(Date.now() + MINIMO_PARA_TENTAR_MS + 100)).resolves.toBe('groq ok')
    expect(c.chamadas).toEqual(['gemini:g1', 'groq:q1'])
  })
})
