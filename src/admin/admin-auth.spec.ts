// As peças da autenticação do painel que não dependem do banco.
//
// Duas delas guardam decisões que custaram caro e não podem voltar atrás sem
// alguém perceber: a credencial de emergência precisa gastar o mesmo tempo com
// usuário certo e errado, e o token estático legado **não vale em produção**.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { duracaoSessaoAdmin, tokenEstaticoConfere, verifyCredentials } from './admin-auth'

const HORA = 60 * 60 * 1000

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('credencial de emergência', () => {
  it('confere usuário e senha do .env', () => {
    expect(verifyCredentials('admin', 'dev-admin-123')).toBe(true)
    expect(verifyCredentials('admin', 'outra')).toBe(false)
    expect(verifyCredentials('root', 'dev-admin-123')).toBe(false)
    expect(verifyCredentials(undefined, undefined)).toBe(false)
  })

  it('ignora espaço em volta do usuário, não da senha', () => {
    expect(verifyCredentials('  admin  ', 'dev-admin-123')).toBe(true)
    expect(verifyCredentials('admin', ' dev-admin-123')).toBe(false)
  })
})

describe('duração da sessão do painel', () => {
  it('padrão de 8 horas, com teto absoluto acima dele', () => {
    const { idleMs, absolutoMs } = duracaoSessaoAdmin()
    expect(idleMs).toBe(8 * HORA)
    expect(absolutoMs).toBeGreaterThanOrEqual(idleMs)
    expect(absolutoMs).toBeLessThanOrEqual(24 * HORA)
  })

  it('nem configurando 100 horas a sessão passa de um dia', () => {
    vi.stubEnv('ADMIN_SESSION_HOURS', '100')
    const { idleMs, absolutoMs } = duracaoSessaoAdmin()
    expect(idleMs).toBe(24 * HORA)
    expect(absolutoMs).toBe(24 * HORA)
  })
})

describe('token estático legado (x-admin-token)', () => {
  it('fora de produção ainda vale — é o que faz curl funcionar na máquina local', () => {
    vi.stubEnv('ADMIN_TOKEN', 'token-longo-de-servico-para-scripts-1234')
    expect(tokenEstaticoConfere('token-longo-de-servico-para-scripts-1234')).toBe(true)
    expect(tokenEstaticoConfere('quase-certo')).toBe(false)
  })

  it('sem ADMIN_TOKEN configurado, cabeçalho nenhum abre a porta', () => {
    vi.stubEnv('ADMIN_TOKEN', '')
    expect(tokenEstaticoConfere('qualquer-coisa')).toBe(false)
  })

  it('EM PRODUÇÃO não vale mais, nem com o valor certo', async () => {
    // Era um bearer sem expiração que, por desenho, pulava o CSRF — um portão
    // lateral em todo o resto do trabalho de segurança do painel. Se este teste
    // falhar, o portão foi reaberto.
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('ADMIN_TOKEN', 'token-longo-de-servico-para-scripts-1234')
    vi.resetModules()
    const { tokenEstaticoConfere: emProducao } = await import('./admin-auth')
    expect(emProducao('token-longo-de-servico-para-scripts-1234')).toBe(false)
  })
})
