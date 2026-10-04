import { describe, expect, it } from 'vitest'
import { precisaPreservarCorpoCru } from './raw-body'

describe('preservação do corpo cru', () => {
  it('nunca duplica em memória o corpo das rotas que recebem cartão', () => {
    expect(precisaPreservarCorpoCru('/api/billing/assinar')).toBe(false)
    expect(precisaPreservarCorpoCru('/api/billing/cartao')).toBe(false)
    expect(precisaPreservarCorpoCru('/api/billing/asaas')).toBe(false)
    expect(precisaPreservarCorpoCru('/api/billing/webhook')).toBe(true)
  })
})
