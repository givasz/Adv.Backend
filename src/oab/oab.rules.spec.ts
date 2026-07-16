// Backend: valida o motor de conformidade (fonte da verdade) e a TRAVA DE PARIDADE
// com o frontend. A suíte exaustiva por categoria vive no frontend (regras idênticas);
// aqui garantimos que o backend bloqueia e que os dois lados não divergem.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkCompliance,
  complianceStatus,
  computeRulesetFingerprint,
  hasBlockingIssue,
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
