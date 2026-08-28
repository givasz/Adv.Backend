import { describe, expect, it } from 'vitest'
import { diaLocal, instanteDoLocal, janelaDoMes, mesAnterior, mesLocal, mesSeguinte } from './tempo'

// O defeito que este arquivo existe para não deixar voltar: datar por UTC.
//
// O servidor roda em UTC. Entre 21h e meia-noite de Brasília — justamente quando
// alguém procura advogado depois do expediente — já é o dia seguinte em UTC.
// Datar por UTC empurraria três horas de movimento para o dia errado, todo dia,
// sem erro nenhum aparecer em lugar nenhum.

const iso = (d: Date) => d.toISOString()

describe('o dia é o de São Paulo, não o do servidor', () => {
  it('21h30 de Brasília ainda é o mesmo dia, mesmo já sendo amanhã em UTC', () => {
    // 2026-08-29T00:30Z  =  2026-08-28 21:30 em São Paulo
    expect(iso(diaLocal(new Date('2026-08-29T00:30:00Z')))).toBe('2026-08-28T00:00:00.000Z')
  })

  it('a virada do dia acontece às 03:00Z, não às 00:00Z', () => {
    expect(iso(diaLocal(new Date('2026-08-29T02:59:00Z')))).toBe('2026-08-28T00:00:00.000Z')
    expect(iso(diaLocal(new Date('2026-08-29T03:01:00Z')))).toBe('2026-08-29T00:00:00.000Z')
  })

  it('o rótulo é meia-noite UTC — um marcador de calendário, não um instante', () => {
    // Guardar o instante real (03:00Z) faria todo ::date no SQL depender do fuso
    // da sessão que consulta, e o Power BI abre a sessão com o fuso que quiser.
    const d = diaLocal(new Date('2026-08-28T18:00:00Z'))
    expect(d.getUTCHours()).toBe(0)
    expect(d.getUTCMinutes()).toBe(0)
  })
})

describe('o mês também é o de São Paulo', () => {
  it('01/09 às 00h30 em UTC ainda é agosto no Brasil', () => {
    expect(iso(mesLocal(new Date('2026-09-01T00:30:00Z')))).toBe('2026-08-01T00:00:00.000Z')
  })

  it('anda para frente e para trás sem cair no mês errado', () => {
    const dezembro = new Date(Date.UTC(2026, 11, 1))
    expect(iso(mesSeguinte(dezembro))).toBe('2027-01-01T00:00:00.000Z')
    expect(iso(mesAnterior(new Date(Date.UTC(2027, 0, 1))))).toBe('2026-12-01T00:00:00.000Z')
  })
})

describe('a janela do mês é de instantes, não de rótulos', () => {
  it('começa e termina às 03:00Z — as três horas de cada ponta são do mês certo', () => {
    const { inicio, fim } = janelaDoMes(new Date(Date.UTC(2026, 7, 1)))
    expect(iso(inicio)).toBe('2026-08-01T03:00:00.000Z')
    expect(iso(fim)).toBe('2026-09-01T03:00:00.000Z')
  })

  it('o fim de um mês é o começo do seguinte — sem buraco e sem sobreposição', () => {
    const agosto = janelaDoMes(new Date(Date.UTC(2026, 7, 1)))
    const setembro = janelaDoMes(new Date(Date.UTC(2026, 8, 1)))
    expect(iso(agosto.fim)).toBe(iso(setembro.inicio))
  })

  it('todo instante da janela volta ao mesmo rótulo de mês', () => {
    const rotulo = new Date(Date.UTC(2026, 7, 1))
    const { inicio, fim } = janelaDoMes(rotulo)
    for (const t of [inicio, new Date(inicio.getTime() + 1), new Date(fim.getTime() - 1)]) {
      expect(iso(mesLocal(t))).toBe(iso(rotulo))
    }
    // e o primeiro instante FORA da janela já é o mês seguinte
    expect(iso(mesLocal(fim))).toBe('2026-09-01T00:00:00.000Z')
  })
})

describe('instanteDoLocal', () => {
  it('devolve o instante real da meia-noite de Brasília', () => {
    expect(iso(instanteDoLocal(2026, 8, 1))).toBe('2026-08-01T03:00:00.000Z')
  })

  it('fecha o ciclo: instante → dia → instante', () => {
    const t = instanteDoLocal(2026, 2, 15)
    expect(iso(diaLocal(t))).toBe('2026-02-15T00:00:00.000Z')
    // e um segundo antes ainda é o dia anterior
    expect(iso(diaLocal(new Date(t.getTime() - 1000)))).toBe('2026-02-14T00:00:00.000Z')
  })
})
