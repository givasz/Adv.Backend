import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acharDadosPessoais } from './dado-pessoal'

// Trava de paridade por COMPORTAMENTO: os casos moram no front e os dois lados
// passam por eles. A tela e o servidor precisam concordar sobre o que é dado
// pessoal — senão a tela deixa salvar e o servidor recusa, ou o contrário.
const CASOS: { texto: string; tipos: string[] }[] = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', 'frontend', 'src', 'lib', 'contratos', 'dadoPessoal.casos.json'),
    'utf8',
  ),
)

describe('dado pessoal num modelo — os casos compartilhados com o front', () => {
  it('há casos dos dois tipos (o teste não passa por não ter o que testar)', () => {
    expect(CASOS.some((c) => c.tipos.length)).toBe(true)
    expect(CASOS.some((c) => !c.tipos.length)).toBe(true)
  })

  it.each(CASOS.map((c) => [c.texto, c.tipos] as const))('%s', (texto, tipos) => {
    expect(acharDadosPessoais(texto).map((a) => a.tipo)).toEqual(tipos)
  })
})

describe('o trecho devolvido não repete o dado', () => {
  it('CPF e e-mail saem mascarados', () => {
    const [cpf, email] = acharDadosPessoais('CPF 529.982.247-25 e joao.silva@exemplo.com.br')
    expect(cpf!.trecho).not.toContain('982')
    expect(cpf!.trecho.startsWith('529')).toBe(true)
    expect(email!.trecho).not.toContain('joao.silva')
  })
})
