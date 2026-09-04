// A honestidade da série, que é a única parte destes números com regra própria.
//
// O resto do levantamento é contagem: erra se a consulta estiver errada, e a
// consulta é conferida rodando. `cobertura` é diferente — ela existe para o
// gráfico não mentir sobre o que NÃO tem, e um defeito aqui não aparece em
// lugar nenhum: some silenciosamente do rodapé e a linha do gráfico passa reta
// por cima do dia em que a rotina não rodou.

import { describe, expect, it } from 'vitest'
import { cobertura, type DiaDaSerie } from './levantamentos.service'

const dia = (d: string): DiaDaSerie => ({ dia: d, free: 1, pro: 0, premium: 0, publicados: 1 })

describe('cobertura da série', () => {
  it('série vazia não inventa intervalo', () => {
    expect(cobertura([])).toEqual({ desde: null, ate: null, dias: 0, buracos: [] })
  })

  it('dias seguidos não têm buraco', () => {
    const c = cobertura(['2026-09-01', '2026-09-02', '2026-09-03'].map(dia))
    expect(c).toMatchObject({ desde: '2026-09-01', ate: '2026-09-03', dias: 3, buracos: [] })
  })

  it('denuncia o dia em que a rotina não rodou', () => {
    const c = cobertura(['2026-09-01', '2026-09-04'].map(dia))
    expect(c.buracos).toEqual(['2026-09-02', '2026-09-03'])
  })

  it('atravessa a virada do mês sem se perder', () => {
    const c = cobertura(['2026-08-30', '2026-09-02'].map(dia))
    expect(c.buracos).toEqual(['2026-08-31', '2026-09-01'])
  })

  it('um dia só é um dia só — não um buraco', () => {
    const c = cobertura([dia('2026-09-04')])
    expect(c).toMatchObject({ desde: '2026-09-04', ate: '2026-09-04', dias: 1, buracos: [] })
  })
})
