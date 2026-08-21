// A porta do painel de moderação — quem decide o que sai do ar.
//
// O painel é o alvo mais valioso da plataforma: quem entrar aqui derruba perfis.
// Estes testes existem para que a sessão dele não volte a ser um token que
// qualquer script da página lê, e para que uma ação de moderação nunca possa ser
// disparada de outro site com a sessão de quem está logado.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ForbiddenException } from '@nestjs/common'

process.env.FRONTEND_ORIGIN = 'https://app.exemplo.com'

import {
  abrirSessaoAdmin,
  ADMIN_COOKIE,
  ADMIN_COOKIE_PATH,
  ADMIN_CSRF_COOKIE,
  assertAdmin,
  encerrarSessaoAdmin,
  sessaoAdmin,
  verifyCredentials,
} from './admin-auth'
import { sessionContext } from '../auth/session-context'

const ORIGEM = 'https://app.exemplo.com'

interface RespostaFalsa {
  headers: Record<string, string | string[]>
  getHeader(nome: string): string | string[] | undefined
  setHeader(nome: string, valor: string | string[]): void
}

function pedido(
  opts: {
    method?: string
    cookies?: Record<string, string>
    origin?: string | null
    csrf?: string
    adminToken?: string
  } = {},
) {
  const res: RespostaFalsa = {
    headers: {},
    getHeader(nome) {
      return this.headers[nome]
    },
    setHeader(nome, valor) {
      this.headers[nome] = valor
    },
  }
  const headers: Record<string, string | undefined> = {
    host: 'api.exemplo.com',
    origin: opts.origin === null ? undefined : (opts.origin ?? ORIGEM),
  }
  if (opts.cookies && Object.keys(opts.cookies).length) {
    headers.cookie = Object.entries(opts.cookies)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('; ')
  }
  if (opts.csrf) headers['x-csrf-token'] = opts.csrf
  const req: Record<string, unknown> = { method: opts.method ?? 'GET', headers }
  sessionContext(req as never, res as never, () => undefined)
  return { req: req as { auth?: never }, res }
}

function setCookies(res: RespostaFalsa): string[] {
  const v = res.headers['Set-Cookie']
  return Array.isArray(v) ? v : v ? [v] : []
}

function cookiesDe(res: RespostaFalsa): Record<string, string> {
  const out: Record<string, string> = {}
  for (const linha of setCookies(res)) {
    const par = linha.split(';')[0] ?? ''
    const i = par.indexOf('=')
    if (i > 0) out[par.slice(0, i)] = decodeURIComponent(par.slice(i + 1))
  }
  return out
}

/** Entra no painel e devolve os cookies com que o navegador voltaria. */
function entrar() {
  const { req, res } = pedido({ method: 'POST' })
  const aberta = abrirSessaoAdmin(req)
  return { aberta, cookies: cookiesDe(res), linhas: setCookies(res) }
}

beforeEach(() => {
  delete process.env.ADMIN_TOKEN
})
afterEach(() => {
  vi.useRealTimers()
})

describe('credenciais', () => {
  it('confere usuário e senha do .env', () => {
    expect(verifyCredentials('admin', 'dev-admin-123')).toBe(true)
    expect(verifyCredentials('admin', 'outra')).toBe(false)
    expect(verifyCredentials('root', 'dev-admin-123')).toBe(false)
    expect(verifyCredentials(undefined, undefined)).toBe(false)
  })
})

describe('sessão do painel', () => {
  it('o cookie é HttpOnly e vale só em /api/admin', () => {
    const { linhas } = entrar()
    const sessao = linhas.find((l) => l.startsWith(ADMIN_COOKIE))!
    expect(sessao).toContain('HttpOnly')
    expect(sessao).toContain(`Path=${ADMIN_COOKIE_PATH}`)
    // O cookie do painel não pode viajar junto de uma visita a perfil público.
    expect(sessao).not.toContain('Path=/;')
  })

  it('nenhuma credencial volta no corpo', () => {
    const { aberta } = entrar()
    expect(Object.keys(aberta).sort()).toEqual(['csrfToken', 'expiresAt'])
  })

  it('o cookie emitido autentica na requisição seguinte', () => {
    const { cookies } = entrar()
    expect(sessaoAdmin(pedido({ cookies }).req)).not.toBeNull()
    expect(() => assertAdmin(pedido({ cookies }).req)).not.toThrow()
  })

  it('id certo com segredo errado não autentica', () => {
    const { cookies } = entrar()
    const id = cookies[ADMIN_COOKIE]!.split('.')[0]
    const forjado = { [ADMIN_COOKIE]: `${id}.segredo-inventado-mas-longo` }
    expect(sessaoAdmin(pedido({ cookies: forjado }).req)).toBeNull()
    expect(() => assertAdmin(pedido({ cookies: forjado }).req)).toThrow(ForbiddenException)
  })

  it('sem cookie nenhum, 403', () => {
    expect(() => assertAdmin(pedido().req)).toThrow(ForbiddenException)
  })

  it('a sessão vence sozinha', () => {
    const { cookies } = entrar()
    expect(sessaoAdmin(pedido({ cookies }).req)).not.toBeNull()
    // Padrão: 8 horas.
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 9 * 60 * 60 * 1000)
    expect(sessaoAdmin(pedido({ cookies }).req)).toBeNull()
  })
})

describe('sair do painel', () => {
  it('encerra de verdade e manda apagar os dois cookies', () => {
    const { cookies } = entrar()
    const saida = pedido({ method: 'POST', cookies })
    encerrarSessaoAdmin(saida.req)

    const apagados = setCookies(saida.res)
    expect(apagados.find((l) => l.startsWith(ADMIN_COOKIE))).toContain('Max-Age=0')
    expect(apagados.find((l) => l.startsWith(ADMIN_CSRF_COOKIE))).toContain('Max-Age=0')
    // Um cookie copiado antes do logout não vale mais.
    expect(sessaoAdmin(pedido({ cookies }).req)).toBeNull()
  })

  it('não dá para derrubar a sessão alheia sabendo só o id', () => {
    const { cookies } = entrar()
    const id = cookies[ADMIN_COOKIE]!.split('.')[0]
    encerrarSessaoAdmin(
      pedido({ method: 'POST', cookies: { [ADMIN_COOKIE]: `${id}.segredo-inventado-mas-longo` } })
        .req,
    )
    expect(sessaoAdmin(pedido({ cookies }).req)).not.toBeNull()
  })

  it('sair sem cookie não explode', () => {
    expect(() => encerrarSessaoAdmin(pedido({ method: 'POST' }).req)).not.toThrow()
  })
})

describe('CSRF no painel', () => {
  it('ação que MODERA sem o token é recusada', () => {
    const { cookies } = entrar()
    expect(() => assertAdmin(pedido({ method: 'POST', cookies }).req)).toThrow(ForbiddenException)
  })

  it('com o token da sessão, passa', () => {
    const { cookies } = entrar()
    const req = pedido({ method: 'POST', cookies, csrf: cookies[ADMIN_CSRF_COOKIE] }).req
    expect(() => assertAdmin(req)).not.toThrow()
  })

  it('origem de outro site é barrada mesmo com o token', () => {
    const { cookies } = entrar()
    const req = pedido({
      method: 'POST',
      cookies,
      csrf: cookies[ADMIN_CSRF_COOKIE],
      origin: 'https://site-do-atacante.com',
    }).req
    expect(() => assertAdmin(req)).toThrow(ForbiddenException)
  })

  it('leitura (GET) não precisa de token', () => {
    const { cookies } = entrar()
    expect(() => assertAdmin(pedido({ cookies }).req)).not.toThrow()
  })
})

describe('token estático legado', () => {
  it('vale sem cookie e sem CSRF — nenhum site consegue forjá-lo do navegador alheio', () => {
    process.env.ADMIN_TOKEN = 'token-longo-de-servico-para-scripts-1234'
    expect(() =>
      assertAdmin(pedido({ method: 'POST' }).req, 'token-longo-de-servico-para-scripts-1234'),
    ).not.toThrow()
  })

  it('token errado continua sendo 403', () => {
    process.env.ADMIN_TOKEN = 'token-longo-de-servico-para-scripts-1234'
    expect(() => assertAdmin(pedido().req, 'quase-certo')).toThrow(ForbiddenException)
  })

  it('sem ADMIN_TOKEN configurado, cabeçalho nenhum abre a porta', () => {
    expect(() => assertAdmin(pedido().req, 'qualquer-coisa')).toThrow(ForbiddenException)
  })
})
