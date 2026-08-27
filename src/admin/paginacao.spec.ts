// A paginação do painel.
//
// O que estes testes protegem não é a aritmética — é a promessa que ela carrega:
// **nenhuma lista do painel corta em silêncio**. Uma lista truncada sem aviso
// lê-se como "é só isso que existe", e num painel que decide o que sai do ar
// isso é pior do que lento.

import { describe, expect, it } from 'vitest'
import { faixa, faixaTrilha, pagina, trilha } from './paginacao'

describe('faixa (deslocamento)', () => {
  it('tem um padrão para quem não pede nada', () => {
    expect(faixa(undefined, undefined)).toEqual({ take: 25, skip: 0 })
  })

  it('respeita o que a tela pediu', () => {
    expect(faixa('50', '100')).toEqual({ take: 50, skip: 100 })
  })

  it('não deixa pedir a tabela inteira', () => {
    // O teto é o mesmo motivo do corte fixo que existia antes. A diferença é que
    // agora a resposta DIZ que cortou.
    expect(faixa('999999', '0').take).toBe(100)
  })

  it('lixo na URL cai no padrão, nunca em NaN', () => {
    for (const v of ['', 'abc', '-5', '0', null, undefined, {}]) {
      const r = faixa(v, v)
      expect(Number.isInteger(r.take), String(v)).toBe(true)
      expect(r.take).toBeGreaterThan(0)
      expect(r.skip).toBe(0)
    }
  })

  it('fração vira inteiro — o banco não aceita meia linha', () => {
    expect(faixa('10.7', '5.9')).toEqual({ take: 10, skip: 5 })
  })
})

describe('pagina', () => {
  it('diz quantos existem ao todo, não só quantos vieram', () => {
    const p = pagina(['a', 'b', 'c'], 140, 3, 0)
    expect(p.total).toBe(140)
    expect(p.temMais).toBe(true)
  })

  it('sabe reconhecer a última fatia', () => {
    expect(pagina(['x'], 4, 3, 3).temMais).toBe(false)
    expect(pagina([], 0, 25, 0).temMais).toBe(false)
  })

  it('a fatia exata do fim não pede mais uma vazia', () => {
    // 25 de 25: o "carregar mais" não pode aparecer para depois não trazer nada.
    expect(pagina(new Array(25).fill('x'), 25, 25, 0).temMais).toBe(false)
  })
})

describe('trilha (cursor)', () => {
  const linhas = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${i}` }))

  it('pede um a mais para saber que há mais — e não o devolve', () => {
    const r = trilha(linhas(11), 10)
    expect(r.itens).toHaveLength(10)
    expect(r.temMais).toBe(true)
    // O cursor é o ÚLTIMO item mostrado: a próxima fatia começa depois dele.
    expect(r.proximo).toBe('a9')
  })

  it('quando vem menos que o pedido, acabou', () => {
    const r = trilha(linhas(4), 10)
    expect(r.itens).toHaveLength(4)
    expect(r.temMais).toBe(false)
  })

  it('lista vazia não devolve cursor', () => {
    expect(trilha([], 10)).toEqual({ itens: [], proximo: null, temMais: false })
  })

  it('exatamente o pedido não promete uma página que não existe', () => {
    expect(trilha(linhas(10), 10).temMais).toBe(false)
  })

  it('faixaTrilha tem padrão e teto próprios', () => {
    expect(faixaTrilha(undefined)).toBe(50)
    expect(faixaTrilha('9999')).toBe(200)
    expect(faixaTrilha('abc')).toBe(50)
  })
})
