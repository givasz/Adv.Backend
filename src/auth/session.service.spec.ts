// A promessa da sessão persistente: o navegador fecha, abre, e a pessoa continua
// dentro — sem que nenhuma linha de JavaScript da página tenha visto a credencial.
//
// Estes testes existem para que ninguém volte a aceitar uma sessão só porque o
// cookie chegou: o segredo tem que conferir com o hash guardado, a linha tem que
// existir, o prazo tem que valer, e um pedido que ESCREVE tem que provar que
// partiu da nossa página (CSRF).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ForbiddenException, UnauthorizedException } from '@nestjs/common'

// Antes de importar o serviço: sem cache, para que mexer na "tabela" apareça na
// leitura seguinte. O cache tem teste próprio, mais abaixo.
process.env.AUTH_SESSION_CACHE_MS = '0'
process.env.FRONTEND_ORIGIN = 'https://app.exemplo.com'

import { CSRF_COOKIE, SESSION_COOKIE } from './cookies'
import { csrfTokenFor } from './csrf'
import { sessionContext } from './session-context'
import { SessionService } from './session.service'
import type { RegistroSessao, SessionStore } from './session-store'

const ORIGEM = 'https://app.exemplo.com'

// ---- Dublês -----------------------------------------------------------------

/** Armazenamento em memória — o mesmo contrato do Postgres e do Redis. */
function loja() {
  const linhas = new Map<string, RegistroSessao>()
  const store: SessionStore = {
    criar: vi.fn(async (r: RegistroSessao) => {
      linhas.set(r.id, { ...r })
    }),
    buscar: vi.fn(async (id: string) => linhas.get(id) ?? null),
    renovar: vi.fn(async (id: string, expiresAt: Date) => {
      const atual = linhas.get(id)
      if (atual) linhas.set(id, { ...atual, expiresAt })
    }),
    apagar: vi.fn(async (id: string) => {
      linhas.delete(id)
    }),
    apagarDoUsuario: vi.fn(async (userId: string) => {
      let n = 0
      for (const [id, r] of [...linhas]) if (r.userId === userId) (linhas.delete(id), n++)
      return n
    }),
    contarAtivas: vi.fn(async (userId: string) => {
      const agora = Date.now()
      return [...linhas.values()].filter(
        (r) => r.userId === userId && r.expiresAt.getTime() > agora,
      ).length
    }),
    limparVencidas: vi.fn(async (userId: string) => {
      const agora = Date.now()
      for (const [id, r] of [...linhas]) {
        if (r.userId === userId && r.expiresAt.getTime() < agora) linhas.delete(id)
      }
    }),
  }
  return { store, linhas, svc: new SessionService(store) }
}

interface RespostaFalsa {
  headers: Record<string, string | string[]>
  getHeader(nome: string): string | string[] | undefined
  setHeader(nome: string, valor: string | string[]): void
}

/** Uma requisição como o Express a entrega, já passada pelo middleware. */
function pedido(opts: { method?: string; cookies?: Record<string, string>; origin?: string | null; csrf?: string } = {}) {
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
  return { req, res }
}

function setCookies(res: RespostaFalsa): string[] {
  const v = res.headers['Set-Cookie']
  return Array.isArray(v) ? v : v ? [v] : []
}

/** Os cookies que a resposta mandou o navegador guardar. */
function cookiesDe(res: RespostaFalsa): Record<string, string> {
  const out: Record<string, string> = {}
  for (const linha of setCookies(res)) {
    const par = linha.split(';')[0] ?? ''
    const i = par.indexOf('=')
    if (i > 0) out[par.slice(0, i)] = decodeURIComponent(par.slice(i + 1))
  }
  return out
}

/** Abre uma sessão e devolve os cookies com que o navegador voltaria. */
async function entrar(svc: SessionService, userId = 'u1', lembrar = true) {
  const { req, res } = pedido({ method: 'POST', csrf: 'ignorado-no-login' })
  const aberta = await svc.abrir(req, userId, lembrar)
  return { aberta, cookies: cookiesDe(res), linhas: setCookies(res) }
}

// ---- Sessão -----------------------------------------------------------------

describe('sessão aberta', () => {
  it('o cookie emitido autentica na requisição seguinte', async () => {
    const { svc } = loja()
    const { cookies } = await entrar(svc)
    const { req } = pedido({ cookies })
    expect(await svc.userIdFrom(req)).toBe('u1')
  })

  it('a credencial vai num cookie HttpOnly — o JavaScript da página não a lê', async () => {
    const { svc } = loja()
    const { linhas } = await entrar(svc)
    const sessao = linhas.find((l) => l.startsWith(SESSION_COOKIE))!
    expect(sessao).toContain('HttpOnly')
    expect(sessao).toContain('SameSite=')
    // O anti-CSRF é o oposto de propósito: a página PRECISA lê-lo para devolvê-lo.
    const csrf = linhas.find((l) => l.startsWith(CSRF_COOKIE))!
    expect(csrf).not.toContain('HttpOnly')
  })

  it('o segredo não é guardado — o que fica é o hash dele', async () => {
    const { svc, linhas } = loja()
    const { cookies } = await entrar(svc)
    const valor = cookies[SESSION_COOKIE]!
    const segredo = valor.slice(valor.indexOf('.') + 1)
    const linha = [...linhas.values()][0]!
    expect(linha.tokenHash).not.toContain(segredo)
    expect(linha.tokenHash).toHaveLength(64) // sha-256 em hex
  })

  it('cada aparelho abre a sua', async () => {
    const { svc, linhas } = loja()
    await entrar(svc)
    await entrar(svc)
    expect(linhas.size).toBe(2)
  })

  it('nenhuma credencial volta no corpo da resposta', async () => {
    const { svc } = loja()
    const { aberta } = await entrar(svc)
    expect(Object.keys(aberta).sort()).toEqual(['csrfToken', 'expiresAt', 'remember'])
  })
})

describe('lembrar de mim', () => {
  it('com "lembrar", o cookie sobrevive ao fechar do navegador (tem Max-Age)', async () => {
    const { svc } = loja()
    const { linhas } = await entrar(svc, 'u1', true)
    const sessao = linhas.find((l) => l.startsWith(SESSION_COOKIE))!
    expect(sessao).toMatch(/Max-Age=\d+/)
    // 30 dias por padrão — sobra muito mais que uma janela aberta.
    const maxAge = Number(/Max-Age=(\d+)/.exec(sessao)![1])
    expect(maxAge).toBeGreaterThan(20 * 24 * 3600)
  })

  it('sem "lembrar", o cookie morre com a janela (sem Max-Age)', async () => {
    const { svc } = loja()
    const { linhas } = await entrar(svc, 'u1', false)
    const sessao = linhas.find((l) => l.startsWith(SESSION_COOKIE))!
    expect(sessao).not.toContain('Max-Age')
  })

  it('a sessão sem "lembrar" também vence antes no servidor', async () => {
    const { svc, linhas } = loja()
    await entrar(svc, 'u1', false)
    const curta = [...linhas.values()][0]!
    linhas.clear()
    await entrar(svc, 'u2', true)
    const longa = [...linhas.values()][0]!
    expect(longa.expiresAt.getTime()).toBeGreaterThan(curta.expiresAt.getTime())
  })
})

// ---- Falha fechada -----------------------------------------------------------

describe('falha fechada', () => {
  it('id de sessão certo com segredo errado não autentica', async () => {
    const { svc } = loja()
    const { cookies } = await entrar(svc)
    const id = cookies[SESSION_COOKIE]!.split('.')[0]
    const { req } = pedido({ cookies: { [SESSION_COOKIE]: `${id}.segredo-inventado-mas-longo` } })
    expect(await svc.userIdFrom(req)).toBeNull()
  })

  it('sessão que não existe não autentica', async () => {
    const { svc } = loja()
    const { req } = pedido({
      cookies: { [SESSION_COOKIE]: 'sessao-inventada.segredo-inventado-mas-longo' },
    })
    expect(await svc.userIdFrom(req)).toBeNull()
  })

  it('sessão vencida por inatividade não autentica', async () => {
    const { svc, linhas } = loja()
    const { cookies } = await entrar(svc)
    const linha = [...linhas.values()][0]!
    linhas.set(linha.id, { ...linha, expiresAt: new Date(Date.now() - 1) })
    const { req } = pedido({ cookies })
    expect(await svc.userIdFrom(req)).toBeNull()
  })

  it('o teto absoluto vence mesmo com a sessão renovada em dia', async () => {
    const { svc, linhas } = loja()
    const { cookies } = await entrar(svc)
    const linha = [...linhas.values()][0]!
    // Renovada agora mesmo, mas passada do limite de vida da sessão.
    linhas.set(linha.id, {
      ...linha,
      expiresAt: new Date(Date.now() + 60_000),
      absoluteExpiresAt: new Date(Date.now() - 1),
    })
    const { req } = pedido({ cookies })
    expect(await svc.userIdFrom(req)).toBeNull()
  })

  it('cookie malformado não autentica', async () => {
    const { svc } = loja()
    for (const valor of ['', 'lixo', 'so-id.', '.so-segredo', 'id.curto']) {
      const { req } = pedido({ cookies: { [SESSION_COOKIE]: valor } })
      expect(await svc.userIdFrom(req)).toBeNull()
    }
  })

  it('banco fora do ar nega em vez de liberar', async () => {
    const { svc, store } = loja()
    const { cookies } = await entrar(svc)
    store.buscar = vi.fn(() => Promise.reject(new Error('sem banco')))
    const { req } = pedido({ cookies })
    expect(await svc.userIdFrom(req)).toBeNull()
  })

  it('requireUser lança 401 quando não há sessão', async () => {
    const { svc } = loja()
    await expect(svc.requireUser(pedido().req)).rejects.toThrow(UnauthorizedException)
  })
})

// ---- Sair --------------------------------------------------------------------

describe('sair', () => {
  it('a credencial para de valer imediatamente e o cookie é apagado', async () => {
    const { svc } = loja()
    const { cookies } = await entrar(svc)

    const saida = pedido({ method: 'POST', cookies })
    expect(await svc.encerrar(saida.req)).toBe('u1')
    const apagado = setCookies(saida.res).find((l) => l.startsWith(SESSION_COOKIE))!
    expect(apagado).toContain('Max-Age=0')

    const depois = pedido({ cookies })
    expect(await svc.userIdFrom(depois.req)).toBeNull()
  })

  it('sair num aparelho não derruba o outro', async () => {
    const { svc } = loja()
    const celular = await entrar(svc)
    const computador = await entrar(svc)

    await svc.encerrar(pedido({ method: 'POST', cookies: celular.cookies }).req)
    expect(await svc.userIdFrom(pedido({ cookies: celular.cookies }).req)).toBeNull()
    expect(await svc.userIdFrom(pedido({ cookies: computador.cookies }).req)).toBe('u1')
  })

  it('não dá para encerrar a sessão alheia sabendo só o id', async () => {
    const { svc } = loja()
    const vitima = await entrar(svc)
    const id = vitima.cookies[SESSION_COOKIE]!.split('.')[0]

    await svc.encerrar(
      pedido({
        method: 'POST',
        cookies: { [SESSION_COOKIE]: `${id}.segredo-inventado-mas-longo` },
      }).req,
    )
    expect(await svc.userIdFrom(pedido({ cookies: vitima.cookies }).req)).toBe('u1')
  })

  it('encerrar todas derruba tudo de uma vez, sem tocar em conta alheia', async () => {
    const { svc } = loja()
    const a = await entrar(svc, 'u1')
    const b = await entrar(svc, 'u1')
    const outro = await entrar(svc, 'u2')

    expect(await svc.encerrarTodas('u1')).toBe(2)
    expect(await svc.userIdFrom(pedido({ cookies: a.cookies }).req)).toBeNull()
    expect(await svc.userIdFrom(pedido({ cookies: b.cookies }).req)).toBeNull()
    expect(await svc.userIdFrom(pedido({ cookies: outro.cookies }).req)).toBe('u2')
  })

  it('sair sem cookie não explode', async () => {
    const { svc } = loja()
    await expect(svc.encerrar(pedido({ method: 'POST' }).req)).resolves.toBeNull()
  })
})

// ---- CSRF --------------------------------------------------------------------

describe('CSRF', () => {
  it('pedido que ESCREVE sem o token é recusado', async () => {
    const { svc } = loja()
    const { cookies } = await entrar(svc)
    const { req } = pedido({ method: 'POST', cookies })
    await expect(svc.requireUser(req)).rejects.toThrow(ForbiddenException)
  })

  it('pedido que escreve COM o token da sessão passa', async () => {
    const { svc } = loja()
    const { cookies } = await entrar(svc)
    const { req } = pedido({ method: 'POST', cookies, csrf: cookies[CSRF_COOKIE] })
    expect(await svc.requireUser(req)).toBe('u1')
  })

  it('o token de OUTRA sessão não serve', async () => {
    const { svc } = loja()
    const alvo = await entrar(svc, 'u1')
    const outra = await entrar(svc, 'u2')
    const { req } = pedido({
      method: 'POST',
      cookies: alvo.cookies,
      csrf: outra.cookies[CSRF_COOKIE],
    })
    await expect(svc.requireUser(req)).rejects.toThrow(ForbiddenException)
  })

  it('origem não autorizada é barrada mesmo com token', async () => {
    const { svc } = loja()
    const { cookies } = await entrar(svc)
    const { req } = pedido({
      method: 'POST',
      cookies,
      csrf: cookies[CSRF_COOKIE],
      origin: 'https://site-do-atacante.com',
    })
    await expect(svc.requireUser(req)).rejects.toThrow(ForbiddenException)
  })

  it('leitura (GET) não precisa de token', async () => {
    const { svc } = loja()
    const { cookies } = await entrar(svc)
    expect(await svc.userIdFrom(pedido({ cookies }).req)).toBe('u1')
  })

  it('sair dispensa o token, mas não a origem', async () => {
    const { svc } = loja()
    const { cookies } = await entrar(svc)
    // Sem token: sair não pode ficar preso porque o token se perdeu.
    const ok = pedido({ method: 'POST', cookies })
    expect(await svc.sessaoAtual(ok.req, { csrf: false })).not.toBeNull()
    // De outro site: aí não.
    const fora = pedido({ method: 'POST', cookies, origin: 'https://site-do-atacante.com' })
    await expect(svc.sessaoAtual(fora.req, { csrf: false })).rejects.toThrow(ForbiddenException)
  })

  it('o token é derivado da sessão — não precisa de linha no banco', async () => {
    const { svc } = loja()
    const { cookies } = await entrar(svc)
    const id = cookies[SESSION_COOKIE]!.split('.')[0]!
    expect(cookies[CSRF_COOKIE]).toBe(csrfTokenFor(id))
  })
})

// ---- Renovação ---------------------------------------------------------------

describe('renovação deslizante', () => {
  it('não grava nada enquanto sobra prazo', async () => {
    const { svc, store } = loja()
    const { cookies } = await entrar(svc)
    ;(store.renovar as ReturnType<typeof vi.fn>).mockClear()
    await svc.userIdFrom(pedido({ cookies }).req)
    expect(store.renovar).not.toHaveBeenCalled()
  })

  it('passada a metade do prazo, empurra o vencimento e reemite o cookie', async () => {
    const { svc, store, linhas } = loja()
    const { cookies } = await entrar(svc)
    const linha = [...linhas.values()][0]!
    // Faltando 10 dias de um prazo de 30: já passou da metade.
    linhas.set(linha.id, { ...linha, expiresAt: new Date(Date.now() + 10 * 86_400_000) })

    const { req, res } = pedido({ cookies })
    expect(await svc.userIdFrom(req)).toBe('u1')
    expect(store.renovar).toHaveBeenCalled()
    expect(linhas.get(linha.id)!.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + 25 * 86_400_000,
    )
    // O navegador também precisa do prazo novo, senão descartaria o cookie antes.
    expect(setCookies(res).some((l) => l.startsWith(SESSION_COOKIE))).toBe(true)
  })

  it('renovar nunca passa do teto absoluto', async () => {
    const { svc, linhas } = loja()
    const { cookies } = await entrar(svc)
    const linha = [...linhas.values()][0]!
    const teto = Date.now() + 2 * 86_400_000
    linhas.set(linha.id, {
      ...linha,
      expiresAt: new Date(Date.now() + 86_400_000),
      absoluteExpiresAt: new Date(teto),
    })
    await svc.userIdFrom(pedido({ cookies }).req)
    expect(linhas.get(linha.id)!.expiresAt.getTime()).toBeLessThanOrEqual(teto)
  })

  it('falha ao renovar não derruba a sessão', async () => {
    const { svc, store, linhas } = loja()
    const { cookies } = await entrar(svc)
    const linha = [...linhas.values()][0]!
    linhas.set(linha.id, { ...linha, expiresAt: new Date(Date.now() + 10 * 86_400_000) })
    store.renovar = vi.fn(() => Promise.reject(new Error('sem banco')))
    expect(await svc.userIdFrom(pedido({ cookies }).req)).toBe('u1')
  })
})

// ---- Carga -------------------------------------------------------------------

describe('carga no servidor', () => {
  it('duas perguntas na MESMA requisição fazem uma leitura só', async () => {
    const { svc, store } = loja()
    const { cookies } = await entrar(svc)
    ;(store.buscar as ReturnType<typeof vi.fn>).mockClear()
    const { req } = pedido({ cookies })
    await svc.userIdFrom(req)
    await svc.userIdFrom(req)
    expect(store.buscar).toHaveBeenCalledTimes(1)
  })

  it('com cache ligado, requisições seguidas não repetem a consulta', async () => {
    process.env.AUTH_SESSION_CACHE_MS = '5000'
    const { svc, store } = loja() // o cache é lido no construtor
    process.env.AUTH_SESSION_CACHE_MS = '0'

    const { cookies } = await entrar(svc)
    ;(store.buscar as ReturnType<typeof vi.fn>).mockClear()
    await svc.userIdFrom(pedido({ cookies }).req)
    await svc.userIdFrom(pedido({ cookies }).req)
    expect(store.buscar).not.toHaveBeenCalled()
  })

  it('mesmo com cache, sair derruba na hora', async () => {
    process.env.AUTH_SESSION_CACHE_MS = '5000'
    const { svc } = loja()
    process.env.AUTH_SESSION_CACHE_MS = '0'

    const { cookies } = await entrar(svc)
    await svc.encerrar(pedido({ method: 'POST', cookies }).req)
    expect(await svc.userIdFrom(pedido({ cookies }).req)).toBeNull()
  })
})

// ---- Higiene -----------------------------------------------------------------

describe('higiene', () => {
  let atual: ReturnType<typeof loja>
  beforeEach(() => {
    atual = loja()
  })

  it('sessões vencidas do usuário saem no login seguinte', async () => {
    const { svc, linhas } = atual
    await entrar(svc)
    const linha = [...linhas.values()][0]!
    linhas.set(linha.id, { ...linha, expiresAt: new Date(Date.now() - 1) })
    await entrar(svc)
    expect(linhas.size).toBe(1)
  })

  it('conta quantos aparelhos estão abertos', async () => {
    const { svc } = atual
    await entrar(svc)
    await entrar(svc)
    expect(await svc.contarAtivas('u1')).toBe(2)
  })
})
