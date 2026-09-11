import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CODIGO_DE_REGISTRO,
  DECLARACAO_DE_REVISAO_VERSAO,
  MODELOS_DE_DOCUMENTO,
  MODELOS_LISTA,
} from './modelos'

// Trava de paridade — mesmo princípio de legal/termos.spec.ts.
//
// O texto dos modelos mora no front e só a revisão viaja. Se a data mudar num lado
// e não no outro, o servidor recusa todo registro daquele modelo ("recarregue a
// página") num laço sem saída — ou, pior, aceita um carimbo que aponta para um
// texto-base que não é o que o advogado usou.
const RAIZ = join(__dirname, '..', '..', '..')
const FRONT = join(RAIZ, 'frontend', 'src', 'lib', 'contratos', 'versoes.ts')

function arquivoDoFront(): string {
  return readFileSync(FRONT, 'utf8')
}

describe('trava de paridade dos modelos de documento (backend ↔ front)', () => {
  it('cada modelo tem a mesma revisão nos dois lados — e nenhum sobra', () => {
    const fonte = arquivoDoFront()
    const bloco = /export const VERSOES_DOS_MODELOS = \{([\s\S]*?)\}/.exec(fonte)?.[1] ?? ''
    const doFront = Object.fromEntries(
      [...bloco.matchAll(/(\w+):\s*'([^']+)'/g)].map((m) => [m[1], m[2]]),
    )
    expect(doFront).toEqual(MODELOS_DE_DOCUMENTO)
  })

  it('a revisão da declaração é a mesma nos dois lados', () => {
    const achado = /export const DECLARACAO_DE_REVISAO_VERSAO = '([^']+)'/.exec(arquivoDoFront())
    expect(achado?.[1]).toBe(DECLARACAO_DE_REVISAO_VERSAO)
  })

  it('as revisões são datas ISO', () => {
    for (const m of MODELOS_LISTA) expect(MODELOS_DE_DOCUMENTO[m]).toMatch(/^\d{4}-\d{2}-\d{2}(-\d+)?$/)
    expect(DECLARACAO_DE_REVISAO_VERSAO).toMatch(/^\d{4}-\d{2}-\d{2}(-\d+)?$/)
  })
})

describe('código de registro', () => {
  it('aceita o formato impresso e recusa letras que se confundem ao ditar', () => {
    expect(CODIGO_DE_REGISTRO.test('AVM-7K2P-9QXD')).toBe(true)
    expect(CODIGO_DE_REGISTRO.test('AVM-7K2P-9QX')).toBe(false)
    expect(CODIGO_DE_REGISTRO.test('avm-7k2p-9qxd')).toBe(false)
    for (const confusa of ['I', 'L', 'O', 'U']) {
      expect(CODIGO_DE_REGISTRO.test(`AVM-7K2P-9QX${confusa}`)).toBe(false)
    }
  })
})
