// A agenda de um advogado sai para o público em DUAS portas: o perfil dele e a
// página do escritório. As duas leem por aqui — se a regra de quem tem agenda
// divergisse, o escritório ofereceria horário de quem desligou o assistente.

import { describe, expect, it } from 'vitest'
import { agendaPublica, gradeDoAssistente } from './agenda-publica'

const GRADE = [
  { weekday: 1, times: ['09:00', '10:00'], faixas: [{ inicio: '09:00', fim: '11:00' }] },
]

const perfil = (over: Record<string, unknown> = {}) => ({
  schedulingMode: 'assistant',
  assistantDays: JSON.stringify(GRADE),
  assistantBusy: '[]',
  assistantDurationMin: 60,
  assistantLeadHours: 2,
  assistantHorizonDays: 14,
  assistantGreeting: 'Olá! Sou o assistente.',
  assistantFloating: true,
  ...over,
})

describe('agenda pública de um advogado', () => {
  it('sai com dias, ocupados e regras — sem a abertura nem o balão, que são do perfil', () => {
    expect(agendaPublica(perfil(), 'pro')).toEqual({
      days: GRADE,
      busy: [],
      durationMin: 60,
      leadHours: 2,
      horizonDays: 14,
    })
  })

  it('não sai sem o assistente ligado', () => {
    for (const modo of ['off', 'whatsapp', 'external', null, undefined]) {
      expect(agendaPublica(perfil({ schedulingMode: modo }), 'pro'), String(modo)).toBeUndefined()
    }
  })

  it('não sai no Free, mesmo com o assistente gravado', () => {
    expect(agendaPublica(perfil(), 'free')).toBeUndefined()
  })

  it('grade vazia ou quebrada não vira agenda', () => {
    expect(agendaPublica(perfil({ assistantDays: '[]' }), 'pro')).toBeUndefined()
    expect(agendaPublica(perfil({ assistantDays: '{nao é json' }), 'pro')).toBeUndefined()
  })
})

describe('gradeDoAssistente', () => {
  it('JSON inválido nos ocupados devolve a grade inteira, não um erro', () => {
    expect(gradeDoAssistente(perfil({ assistantBusy: 'x' })).busy).toEqual([])
  })
})
