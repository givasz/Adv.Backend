import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LIMITES_DO_MODELO_PROPRIO, camposDoTexto } from './modelo-proprio'
import { MODELOS_PROPRIOS_LIMITE } from '../plans'

// Trava de paridade — mesmo princípio de legal/termos.spec.ts. A tela conta
// caracteres e campos para avisar ANTES de salvar; se o limite dela for maior que
// o daqui, a pessoa escreve tudo, aperta salvar e recebe um 400.
const FRONT = join(__dirname, '..', '..', '..', 'frontend', 'src', 'lib')

function numerosDoBloco(fonte: string, nome: string): Record<string, number> {
  const bloco = new RegExp(`export const ${nome} = \\{([\\s\\S]*?)\\}`).exec(fonte)?.[1] ?? ''
  return Object.fromEntries([...bloco.matchAll(/(\w+):\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]))
}

describe('trava de paridade dos modelos próprios (backend ↔ front)', () => {
  it('os limites de texto e de campos são os mesmos nos dois lados', () => {
    const fonte = readFileSync(join(FRONT, 'contratos', 'proprio.ts'), 'utf8')
    expect(numerosDoBloco(fonte, 'LIMITES_DO_MODELO_PROPRIO')).toEqual({ ...LIMITES_DO_MODELO_PROPRIO })
  })

  it('o número de modelos por conta é o mesmo nos dois lados', () => {
    const fonte = readFileSync(join(FRONT, 'plans.ts'), 'utf8')
    expect(/export const MODELOS_PROPRIOS_LIMITE = (\d+)/.exec(fonte)?.[1]).toBe(String(MODELOS_PROPRIOS_LIMITE))
  })
})

describe('campos entre chaves', () => {
  it('lê o nome do campo, sem espaço sobrando, e ignora chave quebrada', () => {
    expect(camposDoTexto('De {  Nome do cliente } a {Valor}. {sem fim')).toEqual(['Nome do cliente', 'Valor'])
  })
})
