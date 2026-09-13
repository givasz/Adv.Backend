import { describe, expect, it } from 'vitest'
import {
  botaoFlutuanteDoCorpo,
  botaoFlutuanteGravado,
  botaoFlutuantePublico,
  colunasDoBotaoFlutuante,
} from './botao-flutuante'

// Um elemento que persegue o visitante pela página: nasce desligado, só liga
// com escolha deliberada, e o perfil que já tinha o balão antigo não o perde.

describe('o que o corpo pede', () => {
  it('vale a escolha nova quando ela vem', () => {
    expect(botaoFlutuanteDoCorpo({ floating: 'whatsapp' })).toBe('whatsapp')
    expect(botaoFlutuanteDoCorpo({ floating: 'assistant' })).toBe('assistant')
    expect(botaoFlutuanteDoCorpo({ floating: 'off', assistant: { floating: true } })).toBe('off')
  })

  it('valor desconhecido desliga — nunca liga por engano', () => {
    for (const lixo of ['sim', true, 1, {}, 'WHATSAPP', null]) {
      expect(botaoFlutuanteDoCorpo({ floating: lixo }), String(lixo)).toBe('off')
    }
  })

  it('cliente antigo, sem a chave nova, ainda liga o balão do assistente', () => {
    expect(botaoFlutuanteDoCorpo({ assistant: { floating: true } })).toBe('assistant')
    expect(botaoFlutuanteDoCorpo({ assistant: { floating: 'true' } })).toBe('off')
    expect(botaoFlutuanteDoCorpo({})).toBe('off')
    expect(botaoFlutuanteDoCorpo(undefined)).toBe('off')
  })

  it('as duas colunas saem coerentes: WhatsApp não liga o balão antigo', () => {
    expect(colunasDoBotaoFlutuante({ floating: 'whatsapp' })).toEqual({
      floatingButton: 'whatsapp',
      assistantFloating: false,
    })
    expect(colunasDoBotaoFlutuante({ floating: 'assistant' })).toEqual({
      floatingButton: 'assistant',
      assistantFloating: true,
    })
  })
})

describe('o que está gravado', () => {
  it('perfil anterior à escolha (coluna nula) mantém o balão que tinha', () => {
    expect(botaoFlutuanteGravado({ floatingButton: null, assistantFloating: true })).toBe('assistant')
    expect(botaoFlutuanteGravado({ floatingButton: null, assistantFloating: false })).toBe('off')
  })

  it('a escolha gravada vence o booleano antigo', () => {
    expect(botaoFlutuanteGravado({ floatingButton: 'whatsapp', assistantFloating: true })).toBe('whatsapp')
    expect(botaoFlutuanteGravado({ floatingButton: 'off', assistantFloating: true })).toBe('off')
  })
})

describe('o que o público recebe', () => {
  it('fora do Pro e do Max não há botão flutuante, mesmo gravado', () => {
    expect(botaoFlutuantePublico({ floatingButton: 'whatsapp' }, 'free')).toBe('off')
    expect(botaoFlutuantePublico({ floatingButton: 'whatsapp' }, 'pro')).toBe('whatsapp')
    expect(botaoFlutuantePublico({ floatingButton: 'assistant' }, 'premium')).toBe('assistant')
  })
})
