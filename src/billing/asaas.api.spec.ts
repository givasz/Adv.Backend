import { describe, expect, it } from 'vitest'
import { ASAAS_TIMEOUT_MS } from './asaas.api'

describe('cliente HTTP do Asaas', () => {
  it('respeita o timeout mínimo de 60 segundos exigido para criar assinatura', () => {
    expect(ASAAS_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000)
  })
})
