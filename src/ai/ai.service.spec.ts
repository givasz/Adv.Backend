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
