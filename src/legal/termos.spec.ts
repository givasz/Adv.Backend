import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { aceiteVigente, TERMS_VERSION } from './termos'

// Trava de paridade — mesmo princípio do ruleset da OAB (oab/oab.rules.spec.ts).
//
// O front exibe a versão; o backend grava. Se as duas divergirem, todo mundo que
// aceitar na tela recebe um carimbo que o servidor considera vencido — a
// plataforma pediria aceite em looping — ou, pior, o contrário: um carimbo
// "vigente" apontando para um texto que ninguém viu.
const RAIZ = join(__dirname, '..', '..', '..')

function constanteDoFront(nome: string): string {
  const arquivo = readFileSync(join(RAIZ, 'frontend', 'src', 'lib', 'legalIdentity.ts'), 'utf8')
  const achado = new RegExp(`export const ${nome} = '([^']+)'`).exec(arquivo)
  if (!achado) throw new Error(`${nome} não encontrada em frontend/src/lib/legalIdentity.ts`)
  return achado[1]
}

describe('trava de paridade dos documentos legais (backend ↔ front)', () => {
  it('a versão dos Termos é a mesma nos dois lados', () => {
    expect(TERMS_VERSION).toBe(constanteDoFront('TERMS_VERSION'))
  })

  it('a versão é uma data ISO — é assim que o aceite fica legível num relatório', () => {
    expect(TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}(-\d+)?$/)
  })
})

describe('aceiteVigente', () => {
  it('conta sem aceite nenhum precisa aceitar', () => {
    expect(aceiteVigente(undefined)).toBe(false)
    expect(aceiteVigente(null)).toBe(false)
    expect(aceiteVigente('')).toBe(false)
  })

  it('versão anterior precisa aceitar de novo', () => {
    expect(aceiteVigente('2026-01-01')).toBe(false)
  })

  it('versão vigente passa', () => {
    expect(aceiteVigente(TERMS_VERSION)).toBe(true)
  })
})
