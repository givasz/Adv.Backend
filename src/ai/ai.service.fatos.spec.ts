// Fato inventado e texto-modelo (12/09/2026).
//
// Dois defeitos medidos com a reserva Groq e os prompts reais:
//   1. a IA escreveu "formada pela Universidade Estadual de Campinas" e
//      "pós-graduação em Direito do Trabalho" para quem só informou "PUC-Campinas"
//      — texto regular para a OAB, e falso;
//   2. o texto-modelo, "garantidamente regular", devolveu "com atuação em a melhor
//      advogada e garanto resultado" com duas vedações.

import { describe, expect, it } from 'vitest'
import { checkCompliance } from '../oab/compliance'
import { AiService } from './ai.service'

type Interno = {
  runModel(p: string, n: number, prazo: number): Promise<string>
  safeTemplate(dto: unknown): string
  sanitizeDto(d: unknown): unknown
  buildPrompt(dto: unknown): string
}

/** Serviço cuja IA devolve os rascunhos na ordem; guarda os prompts que recebeu. */
function comRascunhos(rascunhos: string[]) {
  const s = new AiService()
  const prompts: string[] = []
  ;(s as unknown as Interno).runModel = async (p: string) => {
    prompts.push(p)
    const r = rascunhos.shift()
    if (r === undefined) throw new Error('sem rascunho no roteiro')
    return r
  }
  return { s, prompts }
}

const interno = () => new AiService() as unknown as Interno

describe('a IA não publica fato que ninguém informou', () => {
  const pedido = {
    kind: 'bio',
    name: 'Ana Souza',
    keywords: ['PUC-Campinas', 'direito do trabalho'],
    plan: 'pro',
    maxChars: 600,
  }

  it('o prompt manda usar só os dados do pedido — e não chama palavra-chave de área', () => {
    const s = interno()
    const prompt = s.buildPrompt(s.sanitizeDto(pedido))
    expect(prompt).toContain('SOMENTE os dados')
    expect(prompt).not.toContain('Atua em:')
  })

  it('universidade inventada vai ao reparo com o trecho, e volta o texto consertado', async () => {
    const { s, prompts } = comRascunhos([
      'Sou Ana Souza, formada pela Universidade Estadual de Campinas, com atuação em direito do trabalho.',
      'Sou Ana Souza, formada pela PUC-Campinas, com atuação em direito do trabalho.',
    ])
    const r = await s.generate(pedido as never)
    expect(r.usedFallback).toBe(false)
    expect(r.text).toContain('PUC-Campinas')
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('"Universidade"')
    expect(prompts[1]).toContain('PUC-Campinas') // o reparo sabe o que foi informado
  })

  it('se nem o reparo tira a invenção, sai o texto-modelo — sem a invenção', async () => {
    const inventado = 'Sou Ana Souza, com pós-graduação em Direito do Trabalho.'
    const { s } = comRascunhos([inventado, inventado, inventado, inventado])
    const r = await s.generate(pedido as never)
    expect(r.usedFallback).toBe(true)
    expect(r.text).not.toMatch(/gradua/i)
    expect(r.text).toContain('direito do trabalho')
  })

  it('o que foi informado passa direto, sem gastar reparo', async () => {
    const { s, prompts } = comRascunhos(['Sou Ana Souza, formada pela PUC‑Campinas, com atuação em direito do trabalho.'])
    const r = await s.generate(pedido as never)
    expect(r.usedFallback).toBe(false)
    expect(prompts).toHaveLength(1)
  })

  it('FAQ fala de prazo em anos sem ser barrado', async () => {
    const { s, prompts } = comRascunhos([
      'O prazo é de 2 anos após o fim do contrato, conforme a CLT. Cada caso exige análise própria.',
    ])
    const r = await s.generate({ kind: 'faq', keywords: [], areaLabel: 'Qual o prazo?', plan: 'pro' } as never)
    expect(r.usedFallback).toBe(false)
    expect(prompts).toHaveLength(1)
  })
})

describe('o texto-modelo nunca devolve texto reprovado', () => {
  const template = (d: unknown) => {
    const s = interno()
    return s.safeTemplate(s.sanitizeDto(d))
  }
  const RUINS = ['a melhor advogada', 'garanto resultado', 'honorários grátis']

  it('palavra-chave vedada não entra (caso medido em 12/09/2026)', () => {
    const texto = template({ kind: 'bio', name: 'Ana Souza', keywords: RUINS, plan: 'premium' })
    expect(texto).not.toMatch(/melhor|garant|gr[aá]tis/i)
    expect(checkCompliance(texto)).toEqual([])
  })

  for (const kind of ['bio', 'area', 'headline', 'improve', 'faq']) {
    it(`${kind}: com TUDO vedado no pedido, o resultado passa sem vedação`, () => {
      const texto = template({
        kind,
        name: 'Dra. Ana, a melhor advogada',
        keywords: RUINS,
        areas: RUINS,
        areaLabel: 'a melhor área, garanto resultado',
        currentText: 'Sou a melhor advogada e garanto resultado.',
        plan: 'premium',
      })
      expect(checkCompliance(texto).filter((i) => i.severity === 'block')).toEqual([])
      expect(texto).not.toMatch(/melhor|garant/i)
    })
  }

  it('currículo não vira área de atuação', () => {
    const texto = template({ kind: 'bio', keywords: ['10 anos de atuação', 'PUC-Campinas', 'divórcio'], plan: 'free' })
    expect(texto).toContain('com atuação em divórcio')
    expect(texto).not.toMatch(/PUC|10 anos/)
  })

  it('FAQ: a pergunta não vira sujeito da frase', () => {
    const texto = template({ kind: 'faq', keywords: [], areaLabel: 'Qual o prazo para entrar com ação trabalhista?', plan: 'pro' })
    expect(texto).not.toContain('?')
  })
})
