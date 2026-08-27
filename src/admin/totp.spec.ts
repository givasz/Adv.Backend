// O segundo fator do painel.
//
// Implementação própria (sem pacote) exige teste com os vetores da norma: um TOTP
// que gera códigos "plausíveis" mas errados não falha em lugar nenhum — ele
// simplesmente nunca deixa ninguém entrar, e a conclusão fácil seria "o relógio
// do celular está errado".

import { describe, expect, it } from 'vitest'
import { codigoTotp, novoSegredoTotp, otpauthUrl, segredoLegivel, totpConfere } from './totp'

// Vetores da RFC 6238, apêndice B: segredo ASCII "12345678901234567890" em
// base32, com SHA-1 e 6 dígitos. Os valores esperados são os 6 dígitos finais
// dos códigos de 8 da norma.
const SEGREDO_RFC = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

describe('vetores da RFC 6238', () => {
  const casos: [number, string][] = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ]
  for (const [segundos, esperado] of casos) {
    it(`t=${segundos} → ${esperado}`, () => {
      expect(codigoTotp(SEGREDO_RFC, Math.floor(segundos / 30))).toBe(esperado)
    })
  }
})

describe('conferência', () => {
  const agora = 1_700_000_000_000

  it('aceita o código do momento', () => {
    const codigo = codigoTotp(SEGREDO_RFC, Math.floor(agora / 1000 / 30))
    expect(totpConfere(SEGREDO_RFC, codigo, 1, agora)).toBe(true)
  })

  it('aceita o anterior e o seguinte — relógio de celular atrasa', () => {
    const passo = Math.floor(agora / 1000 / 30)
    expect(totpConfere(SEGREDO_RFC, codigoTotp(SEGREDO_RFC, passo - 1), 1, agora)).toBe(true)
    expect(totpConfere(SEGREDO_RFC, codigoTotp(SEGREDO_RFC, passo + 1), 1, agora)).toBe(true)
  })

  it('recusa o de dois passos atrás — a janela não estica sozinha', () => {
    const passo = Math.floor(agora / 1000 / 30)
    expect(totpConfere(SEGREDO_RFC, codigoTotp(SEGREDO_RFC, passo - 2), 1, agora)).toBe(false)
  })

  it('falha fechada com entrada estragada', () => {
    expect(totpConfere(SEGREDO_RFC, '', 1, agora)).toBe(false)
    expect(totpConfere(SEGREDO_RFC, undefined, 1, agora)).toBe(false)
    expect(totpConfere(SEGREDO_RFC, '12345', 1, agora)).toBe(false)
    expect(totpConfere(null, '123456', 1, agora)).toBe(false)
    expect(totpConfere('!!!não é base32!!!', '123456', 1, agora)).toBe(false)
  })

  it('ignora espaço, que é como a pessoa digita', () => {
    const codigo = codigoTotp(SEGREDO_RFC, Math.floor(agora / 1000 / 30))
    const espacado = `${codigo.slice(0, 3)} ${codigo.slice(3)}`
    expect(totpConfere(SEGREDO_RFC, espacado, 1, agora)).toBe(true)
  })
})

describe('segredo', () => {
  it('sai em base32 e com entropia suficiente', () => {
    const s = novoSegredoTotp()
    expect(s).toMatch(/^[A-Z2-7]{32}$/) // 20 bytes → 32 caracteres
    expect(novoSegredoTotp()).not.toBe(s)
  })

  it('o formato legível volta a valer quando os espaços saem', () => {
    const s = novoSegredoTotp()
    const legivel = segredoLegivel(s)
    expect(legivel).toContain(' ')
    expect(legivel.replace(/\s/g, '')).toBe(s)
    // E o aplicativo aceita as duas formas.
    const codigo = codigoTotp(s, 1000)
    expect(totpConfere(legivel, codigo, 1, 1000 * 30 * 1000)).toBe(true)
  })

  it('o endereço do QR leva o que o aplicativo precisa', () => {
    const url = new URL(otpauthUrl('ABCDEFGHIJKLMNOP', 'ana@exemplo.com'))
    expect(url.protocol).toBe('otpauth:')
    expect(url.searchParams.get('secret')).toBe('ABCDEFGHIJKLMNOP')
    expect(url.searchParams.get('digits')).toBe('6')
    expect(url.searchParams.get('period')).toBe('30')
    expect(decodeURIComponent(url.pathname)).toContain('ana@exemplo.com')
  })
})
