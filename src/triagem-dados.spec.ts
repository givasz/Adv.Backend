import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { conferirPergunta, conferirPerguntaInteira, perguntaBloqueada } from './triagem-dados'

// Trava de paridade por COMPORTAMENTO: os casos moram no front e os dois lados
// passam por eles. A tela e o servidor precisam concordar sobre o que uma
// pergunta está pedindo — senão o advogado escreve, vê "tudo certo" e o salvar
// falha (ou, pior, a tela avisa e o servidor grava calado).
const CASOS: { pergunta: string; achados: string[] }[] = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', 'frontend', 'src', 'lib', 'triagem.casos.json'),
    'utf8',
  ),
)

describe('o que a pergunta está pedindo — os casos compartilhados com o front', () => {
  it('há casos limpos, de aviso e de bloqueio (o teste não passa por não ter o que testar)', () => {
    expect(CASOS.some((c) => !c.achados.length)).toBe(true)
    expect(CASOS.some((c) => c.achados.some((a) => a.endsWith(':aviso')))).toBe(true)
    expect(CASOS.some((c) => c.achados.some((a) => a.endsWith(':bloqueio')))).toBe(true)
  })

  it.each(CASOS.map((c) => [c.pergunta, c.achados] as const))('%s', (pergunta, achados) => {
    expect(conferirPergunta(pergunta).map((a) => `${a.tipo}:${a.risco}`)).toEqual(achados)
  })
})

describe('o servidor recusa só o que nunca tem uso legítimo', () => {
  it('senha, cartão e conta bancária', () => {
    expect(perguntaBloqueada({ label: 'Qual a sua senha?' })?.tipo).toBe('credencial')
    expect(perguntaBloqueada({ label: 'Informe o número do cartão' })?.tipo).toBe('cartao')
    expect(perguntaBloqueada({ label: 'Qual sua conta corrente?' })?.tipo).toBe('bancario')
  })

  it('CPF, saúde e renda avisam, mas gravam — quem decide é o advogado', () => {
    for (const p of ['Qual o seu CPF?', 'Qual seu diagnóstico?', 'Qual seu salário?']) {
      expect(conferirPergunta(p).length).toBeGreaterThan(0)
      expect(perguntaBloqueada({ label: p })).toBeNull()
    }
  })

  it('“processo” e “documento” sozinhos nunca bloqueiam nem avisam', () => {
    expect(conferirPergunta('Você já possui processo sobre isso?')).toEqual([])
    expect(conferirPergunta('Você tem documentos do caso?')).toEqual([])
  })
})

describe('a brecha da opção de resposta', () => {
  it('o bloqueio vale para a pergunta INTEIRA, não só para o enunciado', () => {
    // "Qual informação você quer enviar?" com a opção "Minha senha do banco"
    // passava pelos dois portões: o visitante lê as opções tanto quanto lê a
    // pergunta, e é nelas que ele toca.
    const pergunta = {
      label: 'Qual informação você quer enviar?',
      options: [{ texto: 'Minha senha do banco' }],
    }
    expect(perguntaBloqueada({ label: pergunta.label })).toBeNull()
    expect(perguntaBloqueada(pergunta)?.tipo).toBe('credencial')
  })

  it('cada tipo aparece uma vez só, mesmo repetido entre enunciado e opções', () => {
    const achados = conferirPerguntaInteira({
      label: 'Qual o seu CPF?',
      options: [{ texto: 'Mando o CPF' }, { texto: 'Mando o RG' }],
    })
    expect(achados.filter((a) => a.tipo === 'documento')).toHaveLength(1)
  })
})
