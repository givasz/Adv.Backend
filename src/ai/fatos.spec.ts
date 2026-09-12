import { describe, expect, it } from 'vitest'
import { fatosNaoInformados, pareceFato, type DadosDoPedido } from './fatos'

// A checagem da OAB não pega fato FALSO. Estes testes são do que ela não vê: o
// dado de currículo que a IA acrescentou por conta própria (ver fatos.ts).

const pedido = (keywords: string[], extra: Partial<DadosDoPedido> = {}): DadosDoPedido => ({
  keywords,
  ...extra,
})
const trechos = (texto: string, dados: DadosDoPedido, escopo?: 'perfil' | 'area') =>
  fatosNaoInformados(texto, dados, escopo).map((f) => f.matchedText)

describe('fatosNaoInformados — o que a IA acrescentou por conta própria', () => {
  it('pega a universidade e a pós que ninguém informou (caso medido em 12/09/2026)', () => {
    // Texto de verdade do gpt-oss-120b, com o hífen não separável que ele usa.
    const texto =
      'Sou Ana Souza, advogada. Formada em Direito pela Universidade Estadual de Campinas (UNICAMP) e com pós‑graduação em Direito do Trabalho.'
    const r = trechos(texto, pedido(['PUC-Campinas']))
    expect(r).toContain('UNICAMP')
    expect(r).toContain('Universidade')
    expect(r).toContain('pós‑graduação')
  })

  it('o que foi informado fica, mesmo escrito de outro jeito', () => {
    const texto = 'Sou Ana, com dez anos de atuação, formada pela PUC‑Campinas.'
    expect(fatosNaoInformados(texto, pedido(['10 anos de atuação', 'PUC-Campinas']))).toEqual([])
  })

  it('tempo de experiência inventado', () => {
    expect(trechos('Atuo há mais de 15 anos na área trabalhista.', pedido(['trabalhista']))).toEqual([
      'há mais de 15 anos',
    ])
    expect(trechos('Advogo desde 2010 em Campinas.', pedido(['família']))).toEqual(['Advogo desde 2010'])
  })

  it('anos que são assunto, e não currículo, passam', () => {
    expect(
      fatosNaoInformados('A aposentadoria exige 15 anos de contribuição.', pedido(['aposentadoria']), 'area'),
    ).toEqual([])
  })

  it('seccional da OAB deduzida da cidade é invenção', () => {
    expect(trechos('Advogada inscrita na OAB/SP, em Campinas.', pedido([], { city: 'Campinas/SP' }))).toEqual([
      'OAB/SP',
    ])
    expect(fatosNaoInformados('Inscrita na OAB/SP 123.456.', pedido(['OAB/SP 123456']))).toEqual([])
  })

  it('cargo inventado é pego; o mesmo cargo informado passa', () => {
    const texto = 'Sou professora universitária e atuo em Direito Civil.'
    expect(trechos(texto, pedido(['direito civil']))).toEqual(['Sou professora'])
    expect(fatosNaoInformados(texto, pedido(['docente', 'direito civil']))).toEqual([])
  })

  it('"formada em Direito" é verdade de todo advogado', () => {
    expect(fatosNaoInformados('Sou formada em Direito e atuo com famílias.', pedido(['família']))).toEqual([])
  })

  it('"sociedade unipessoal" não é a UNIP', () => {
    expect(fatosNaoInformados('Atuo por sociedade unipessoal de advocacia.', pedido(['família']))).toEqual([])
  })

  it('descrição de área fala de faculdade sem ser currículo', () => {
    expect(
      fatosNaoInformados('Atuação em matrícula e mensalidade de faculdade.', pedido(['FIES']), 'area'),
    ).toEqual([])
  })

  it('o que foi dito no texto a revisar conta como informado', () => {
    const atual = 'Sou mestre em Direito Civil pela USP.'
    expect(fatosNaoInformados('Mestre em Direito Civil pela USP.', pedido([], { currentText: atual }))).toEqual([])
  })
})

describe('pareceFato — currículo não é tema de atuação', () => {
  it('separa uma coisa da outra', () => {
    expect(pareceFato('10 anos de atuação')).toBe(true)
    expect(pareceFato('PUC-Campinas')).toBe(true)
    expect(pareceFato('OAB/SP 123.456')).toBe(true)
    expect(pareceFato('pós-graduação em família')).toBe(true)
    expect(pareceFato('divórcio')).toBe(false)
    expect(pareceFato('Direito Previdenciário')).toBe(false)
  })
})
