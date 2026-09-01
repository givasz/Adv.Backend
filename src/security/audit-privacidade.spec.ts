// O registro de segurança não pode virar uma lista de e-mails.
//
// `logSecurityEvent` já cuidava disso no campo `subject` (que leva a impressão
// digital, nunca o endereço). O furo estava do outro lado: quando um limite
// estoura, `enforceRateLimit` grava uma linha com a CHAVE do limitador dentro
// (`resource`) — e a chave do login por e-mail era montada com o e-mail cru.
//
// Ou seja: bastava alguém errar a senha oito vezes para o endereço dele ficar
// escrito no log da API. Um arquivo de log com e-mails é a mesma lista de
// clientes que a proteção contra enumeração existe para não entregar — e ele
// sobrevive em backup, sai em anexo de chamado e vai para o coletor de logs.
//
// Estes testes olham o que de fato SAI no console, porque é lá que o dado
// vazava. Conferir a função de fingerprint isoladamente não teria pego nada: ela
// sempre esteve certa; quem não a usava era a chave.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUTH_RATE_RULES, enforceRateLimit, resetRateLimits } from './rate-limit'
import { fingerprint, logSecurityEvent } from './audit-log'

const EMAIL = 'marina.sales@escritorio.com.br'

/** Captura as linhas que o log de segurança escreveria. */
function capturar(fn: () => void): string {
  const linhas: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((l: unknown) => {
    linhas.push(String(l))
  })
  try {
    fn()
  } finally {
    spy.mockRestore()
  }
  return linhas.join('\n')
}

afterEach(() => resetRateLimits())

describe('impressão digital do e-mail', () => {
  it('não é reversível e não contém o endereço', () => {
    const fp = fingerprint(EMAIL)!
    expect(fp).not.toContain('marina')
    expect(fp).not.toContain('@')
    expect(fp).toHaveLength(12)
  })

  it('é determinística — serve como chave estável de limite', () => {
    expect(fingerprint(EMAIL)).toBe(fingerprint(EMAIL))
    // Caixa e espaços em volta não criam um balde novo: senão trocar
    // "Marina@..." por "marina@..." zeraria o contador de tentativas.
    expect(fingerprint(' MARINA.SALES@escritorio.com.BR ')).toBe(fingerprint(EMAIL))
  })

  it('distingue contas diferentes', () => {
    expect(fingerprint(EMAIL)).not.toBe(fingerprint('outra@escritorio.com.br'))
  })

  it('e-mail vazio não vira uma chave qualquer', () => {
    expect(fingerprint('')).toBeUndefined()
    expect(fingerprint(undefined)).toBeUndefined()
  })
})

describe('estouro de limite no login', () => {
  // O mesmo formato de chave que auth.controller.ts monta.
  const chave = () => `login:email:${fingerprint(EMAIL) ?? 'sem-email'}`

  it('a linha de auditoria não carrega o e-mail', () => {
    const saida = capturar(() => {
      for (let i = 0; i < AUTH_RATE_RULES.loginPerEmail.max + 1; i++) {
        try {
          enforceRateLimit([[chave(), AUTH_RATE_RULES.loginPerEmail]])
        } catch {
          // o 429 é o esperado; o que interessa é o que foi escrito
        }
      }
    })
    expect(saida).toContain('rate_limited')
    expect(saida).not.toContain(EMAIL)
    expect(saida).not.toContain('marina')
    expect(saida).not.toContain('@escritorio')
    // O que entra no lugar é a impressão digital — que ainda correlaciona as
    // tentativas contra a MESMA conta, que é para o que o log serve.
    expect(saida).toContain(fingerprint(EMAIL)!)
  })

  it('o limite continua contando por conta, não por requisição', () => {
    const regra = AUTH_RATE_RULES.loginPerEmail
    for (let i = 0; i < regra.max; i++) {
      expect(() => enforceRateLimit([[chave(), regra]])).not.toThrow()
    }
    expect(() => enforceRateLimit([[chave(), regra]])).toThrow()
    // Outra conta tem o próprio balde: o ataque contra uma não tranca a outra.
    const outra = `login:email:${fingerprint('outra@escritorio.com.br')}`
    expect(() => enforceRateLimit([[outra, regra]])).not.toThrow()
  })
})

describe('nenhum evento de segurança carrega dado pessoal', () => {
  it('o e-mail não entra nem quando alguém o passa como assunto', () => {
    const saida = capturar(() =>
      logSecurityEvent({
        event: 'login_fail',
        ip: '203.0.113.10',
        subject: fingerprint(EMAIL),
        result: 'negado',
      }),
    )
    expect(saida).not.toContain(EMAIL)
    expect(JSON.parse(saida).subject).toBe(fingerprint(EMAIL))
  })

  it('o User-Agent é cortado — cabeçalho é campo livre de quem chama', () => {
    const saida = capturar(() =>
      logSecurityEvent({ event: 'login_fail', result: 'negado', userAgent: 'x'.repeat(5000) }),
    )
    expect(JSON.parse(saida).userAgent.length).toBeLessThanOrEqual(180)
  })
})

describe('login do painel admin', () => {
  it('tem teto por conta, e ele não trava as outras contas', () => {
    const regra = AUTH_RATE_RULES.adminLoginPerAccount
    const chaveDe = (u: string) => `admin-login:conta:${fingerprint(u)}`
    for (let i = 0; i < regra.max; i++) {
      expect(() => enforceRateLimit([[chaveDe('admingiva'), regra]])).not.toThrow()
    }
    expect(() => enforceRateLimit([[chaveDe('admingiva'), regra]])).toThrow()
    expect(() => enforceRateLimit([[chaveDe('outro-admin'), regra]])).not.toThrow()
  })

  it('o teto global é backstop, não alavanca para desligar o painel', () => {
    // Com o global em 40, quarenta tentativas erradas de um estranho trancavam
    // TODOS os administradores por quinze minutos — sem conhecer usuário nem
    // senha. Num painel que existe para tirar conteúdo do ar, desligá-lo de fora
    // é falha de disponibilidade, e era a mais barata que havia aqui.
    expect(AUTH_RATE_RULES.adminLoginGlobal.max).toBeGreaterThan(
      AUTH_RATE_RULES.adminLoginPerAccount.max * 10,
    )
    // E o teto fino continua sendo o por-conta e o por-IP.
    expect(AUTH_RATE_RULES.adminLoginPerAccount.max).toBeLessThanOrEqual(10)
    expect(AUTH_RATE_RULES.adminLoginPerIp.max).toBeLessThanOrEqual(10)
  })

  it('a chave do painel também não leva o usuário em claro', () => {
    const saida = capturar(() => {
      const regra = AUTH_RATE_RULES.adminLoginPerAccount
      for (let i = 0; i < regra.max + 1; i++) {
        try {
          enforceRateLimit([[`admin-login:conta:${fingerprint('admingiva')}`, regra]])
        } catch {
          // esperado
        }
      }
    })
    expect(saida).toContain('rate_limited')
    expect(saida).not.toContain('admingiva')
  })
})
