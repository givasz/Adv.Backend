// Backend: valida o motor de conformidade (fonte da verdade) e a TRAVA DE PARIDADE
// com o frontend. A suíte exaustiva por categoria vive no frontend (regras idênticas);
// aqui garantimos que o backend bloqueia e que os dois lados não divergem.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  blockingFields,
  checkCompliance,
  complianceStatus,
  computeRulesetFingerprint,
  hasBlockingIssue,
  publicStatus,
} from './compliance'

describe('backend compliance — fonte da verdade', () => {
  it('bloqueia termos vedados com apontamento explicativo', () => {
    const issues = checkCompliance('Resultado 100% garantido, honorários com desconto')
    expect(hasBlockingIssue('Resultado 100% garantido')).toBe(true)
    const promise = issues.find((i) => i.ruleId === 'promise-result')!
    expect(promise.category).toBe('promise')
    expect(promise.suggestion).toBeTruthy()
    expect(promise.explanation).toBeTruthy()
  })

  it('aprova texto sóbrio', () => {
    expect(complianceStatus('Advogada com atuação em direito de família e sucessões.')).toBe('ok')
  })
})

describe('trava de paridade do ruleset (backend ↔ lock)', () => {
  it('o fingerprint do backend bate com docs/oab-ruleset.lock', () => {
    const lockPath = join(__dirname, '..', '..', '..', 'docs', 'oab-ruleset.lock')
    const lock = readFileSync(lockPath, 'utf8').trim()
    expect(computeRulesetFingerprint()).toBe(lock)
  })
})

// O backend é quem RECUSA a publicação — e recusava olhando só bio, descrição de
// área e FAQ. A frase de apresentação passava direto. Aqui a cobertura fica travada
// no lado que decide, não só no editor.
describe('publicStatus — cobertura no lado que bloqueia', () => {
  it('a frase de apresentação sozinha barra a publicação', () => {
    expect(publicStatus({ headline: 'O melhor advogado da cidade' })).toBe('block')
    expect(blockingFields({ headline: 'O melhor advogado da cidade' })).toEqual([
      'Frase de apresentação',
    ])
  })

  it('abertura do assistente e nome no rodapé também barram', () => {
    expect(publicStatus({ assistant: { greeting: 'Consulta grátis, fale agora' } })).toBe('block')
    expect(publicStatus({ branding: { brandName: 'Advocacia Êxito Garantido' } })).toBe('block')
  })

  it('perfil sóbrio e completo passa inteiro', () => {
    expect(
      publicStatus({
        headline: 'Advogada · Direito de Família',
        bio: 'Atuo em direito de família há doze anos.',
        areas: [{ label: 'Arbitramento de honorários', description: 'Ações de honorários.' }],
        assistant: { greeting: 'Olá! Posso ajudar a marcar um horário.' },
        branding: { brandName: 'Sales Advocacia' },
      }),
    ).toBe('ok')
  })
})
