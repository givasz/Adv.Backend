import { describe, expect, it } from 'vitest'
import { cnpjValido, cpfValido, documentoValido } from './documento'

// Números de exemplo gerados pelo algoritmo, não de pessoas. O CNPJ é o da
// própria Self Coding, que é público (comprovante de inscrição no CNPJ).

describe('CPF', () => {
  it('aceita com e sem pontuação', () => {
    expect(cpfValido('529.982.247-25')).toBe(true)
    expect(cpfValido('52998224725')).toBe(true)
  })

  it('recusa dígito verificador errado', () => {
    expect(cpfValido('529.982.247-24')).toBe(false)
    expect(cpfValido('529.982.247-15')).toBe(false)
  })

  it('recusa a sequência repetida, que passa na conta mas não existe', () => {
    for (const d of '0123456789') expect(cpfValido(d.repeat(11))).toBe(false)
  })

  it('recusa tamanho errado e o que não é texto', () => {
    expect(cpfValido('5299822472')).toBe(false)
    expect(cpfValido(52998224725)).toBe(false)
    expect(cpfValido(undefined)).toBe(false)
  })
})

describe('CNPJ', () => {
  it('aceita o da Self Coding, com e sem pontuação', () => {
    expect(cnpjValido('69.366.280/0001-52')).toBe(true)
    expect(cnpjValido('69366280000152')).toBe(true)
  })

  it('recusa dígito verificador errado e sequência repetida', () => {
    expect(cnpjValido('69.366.280/0001-53')).toBe(false)
    expect(cnpjValido('1'.repeat(14))).toBe(false)
  })
})

describe('documentoValido', () => {
  it('devolve só os dígitos quando é CPF ou CNPJ válido', () => {
    expect(documentoValido('529.982.247-25')).toBe('52998224725')
    expect(documentoValido('69.366.280/0001-52')).toBe('69366280000152')
  })

  it('devolve null para o resto', () => {
    expect(documentoValido('123')).toBeNull()
    expect(documentoValido('529.982.247-24')).toBeNull()
    expect(documentoValido('')).toBeNull()
    expect(documentoValido(null)).toBeNull()
  })
})
