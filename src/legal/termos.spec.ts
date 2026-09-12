import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { aceiteVigente, OPERADOR, TERMS_VERSION } from './termos'
import { CORREIO_NA_POLITICA_DESDE } from '../mail/config'

// Trava de paridade — mesmo princípio do ruleset da OAB (oab/oab.rules.spec.ts).
//
// O front exibe a versão; o backend grava. Se as duas divergirem, todo mundo que
// aceitar na tela recebe um carimbo que o servidor considera vencido — a
// plataforma pediria aceite em looping — ou, pior, o contrário: um carimbo
// "vigente" apontando para um texto que ninguém viu.
const RAIZ = join(__dirname, '..', '..', '..')

function arquivoDoFront(...partes: string[]): string {
  return readFileSync(join(RAIZ, 'frontend', 'src', 'lib', ...partes), 'utf8')
}

function constanteDoFront(nome: string): string {
  const achado = new RegExp(`export const ${nome} = '([^']+)'`).exec(arquivoDoFront('legalIdentity.ts'))
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

  it('o operador do rodapé dos e-mails é o mesmo que os documentos identificam', () => {
    // Um e-mail assinado por uma razão social e uns Termos por outra são duas
    // partes diferentes para quem lê — e para quem julga.
    const fonte = arquivoDoFront('legalIdentity.ts')
    expect(fonte).toContain(`razaoSocial: '${OPERADOR.razaoSocial}'`)
    expect(fonte).toContain(`cnpj: '${OPERADOR.cnpj}'`)
  })
})

describe('o correio só liga quando a Política declara o provedor', () => {
  it('se a constante diz que declara, o texto da Política de fato menciona o Resend', () => {
    // A constante é a chave que liga o envio em produção (ver mail/config.ts).
    // Sem esta conferência, bastaria trocá-la para ligar o correio com a
    // Política ainda calada sobre quem recebe o e-mail de cada pessoa.
    if (CORREIO_NA_POLITICA_DESDE === null) return
    expect(TERMS_VERSION >= CORREIO_NA_POLITICA_DESDE).toBe(true)
    expect(arquivoDoFront('legalContent.ts')).toMatch(/Resend/)
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
