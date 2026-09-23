// A agenda de um advogado sai para o público em DUAS portas: o perfil dele e a
// página do escritório. As duas leem por aqui — se a regra de quem tem agenda
// divergisse, o escritório ofereceria horário de quem desligou o assistente.

import { describe, expect, it } from 'vitest'
import { agendaPublica, gradeDoAssistente, triagemPublica } from './agenda-publica'

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

// A TRIAGEM sai pelas mesmas duas portas que a agenda: o perfil do advogado e a
// página do escritório, que faz as perguntas DELE ao visitante que o escolhe.
//
// A leitura morava dentro de profiles.service, privada — e foi exatamente por
// isso que a página da sociedade nasceu sem triagem nenhuma, pulando o que o
// mesmo advogado perguntava no perfil.
describe('triagem pública de um advogado', () => {
  const comTriagem = (over: Record<string, unknown> = {}) => ({
    triageEnabled: true,
    triageQuestions: JSON.stringify([
      { id: 'q1', kind: 'escolha', label: 'A empresa já foi formalizada?', options: [{ id: 's', texto: 'Sim' }] },
    ]),
    triageSkipSteps: JSON.stringify(['nome']),
    ...over,
  })

  it('sai com as perguntas e com as etapas que o advogado tirou da conversa', () => {
    const t = triagemPublica(comTriagem(), 'premium')
    expect(t?.enabled).toBe(true)
    expect(t?.questions).toHaveLength(1)
    // A escolha dele de não perguntar o nome vale nas duas portas.
    expect(t?.semEtapas).toEqual(['nome'])
  })

  it('fora do Max não sai — a trava vale na LEITURA, não só na gravação', () => {
    // Pela janela entre o vencimento da assinatura e a varredura que reconcilia
    // o banco, as colunas seguem preenchidas. Mesmo motivo do vídeo e do balão.
    expect(triagemPublica(comTriagem(), 'pro')).toBeUndefined()
    expect(triagemPublica(comTriagem(), 'free')).toBeUndefined()
  })

  it('interruptor desligado é o mesmo que não ter triagem', () => {
    expect(triagemPublica(comTriagem({ triageEnabled: false }), 'premium')).toBeUndefined()
  })

  it('triagem ligada e sem pergunta respondível não vira conversa vazia', () => {
    expect(
      triagemPublica(comTriagem({ triageQuestions: '[]' }), 'premium'),
    ).toBeUndefined()
  })

  it('JSON quebrado não derruba a página — vira triagem nenhuma', () => {
    expect(triagemPublica(comTriagem({ triageQuestions: '{' }), 'premium')).toBeUndefined()
    // E uma lista de etapas inválida não impede as perguntas de saírem.
    expect(triagemPublica(comTriagem({ triageSkipSteps: 'nao-e-json' }), 'premium')?.questions)
      .toHaveLength(1)
  })
})
