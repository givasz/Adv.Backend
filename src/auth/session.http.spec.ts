// A sessão vista de fora, por HTTP de verdade.
//
// Os testes do serviço conferem a lógica; este confere o FIO: o cabeçalho
// Set-Cookie que sai, o cabeçalho Cookie que volta, e o que acontece quando um
// cliente real repete o ciclo. É onde apareceriam os erros que nenhum dublê pega
// — um atributo escrito errado, um cookie que o navegador não guardaria, um
// caminho que impede o cookie de voltar.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'

process.env.AUTH_SESSION_CACHE_MS = '0'
process.env.FRONTEND_ORIGIN = 'http://localhost:5173'

import { sessionContext } from './session-context'
import { SessionService } from './session.service'
import type { RequisicaoComAuth } from './session-context'
import type { RegistroSessao, SessionStore } from './session-store'

const ORIGEM = 'http://localhost:5173'

function lojaEmMemoria(): SessionStore {
  const linhas = new Map<string, RegistroSessao>()
  return {
    async criar(r) {
      linhas.set(r.id, { ...r })
    },
    async buscar(id) {
      return linhas.get(id) ?? null
    },
    async renovar(id, expiresAt) {
      const a = linhas.get(id)
      if (a) linhas.set(id, { ...a, expiresAt })
    },
    async apagar(id) {
      linhas.delete(id)
    },
    async apagarDoUsuario(userId) {
      let n = 0
      for (const [id, r] of [...linhas]) if (r.userId === userId) (linhas.delete(id), n++)
      return n
    },
    async contarAtivas(userId) {
      return [...linhas.values()].filter((r) => r.userId === userId).length
    },
    async limparVencidas() {
      /* nada */
    },
  }
}

const svc = new SessionService(lojaEmMemoria())
let server: Server
let base: string

/** Um servidor mínimo com as quatro rotas que importam. */
function rotas(bruta: IncomingMessage, res: ServerResponse) {
  const req = bruta as IncomingMessage & RequisicaoComAuth
  sessionContext(req as never, res as never, () => {
    void (async () => {
      const caminho = req.url ?? '/'
      try {
        if (caminho === '/login') {
          const aberta = await svc.abrir(req, 'u1', true)
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(aberta))
          return
        }
        if (caminho === '/logout') {
          await svc.encerrar(req)
          res.statusCode = 204
          res.end()
          return
        }
        // /me (GET) e /salvar (POST) exigem sessão.
        const userId = await svc.requireUser(req)
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ userId }))
      } catch (err) {
        const status = (err as { getStatus?: () => number }).getStatus?.() ?? 500
        res.statusCode = status
        res.end(JSON.stringify({ erro: status }))
      }
    })()
  })
}

beforeAll(async () => {
  server = createServer(rotas)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

/** Guarda os cookies como um navegador guardaria (só o par nome=valor). */
class Navegador {
  private jar = new Map<string, string>()

  async ir(caminho: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('Origin', ORIGEM)
    if (this.jar.size) {
      headers.set('Cookie', [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '))
    }
    const res = await fetch(`${base}${caminho}`, { ...init, headers })
    for (const linha of res.headers.getSetCookie()) {
      const par = linha.split(';')[0] ?? ''
      const i = par.indexOf('=')
      if (i < 1) continue
      const nome = par.slice(0, i)
      const valor = par.slice(i + 1)
      // Max-Age=0 é "esqueça este cookie" — um navegador o remove.
      if (!valor || /Max-Age=0(?:;|$)/i.test(linha)) this.jar.delete(nome)
      else this.jar.set(nome, valor)
    }
    return res
  }

  cookie(nome: string): string | undefined {
    return this.jar.get(nome)
  }
}

describe('o ciclo completo por HTTP', () => {
  it('entrar, continuar entrado, escrever com o token e sair', async () => {
    const nav = new Navegador()

    // 1. Entrar: a resposta não traz credencial nenhuma no corpo.
    const login = await nav.ir('/login', { method: 'POST' })
    const corpo = (await login.json()) as { csrfToken: string; expiresAt: number }
    expect(JSON.stringify(corpo)).not.toContain(nav.cookie('advocme_session') ?? 'impossível')
    const set = login.headers.getSetCookie().find((l) => l.startsWith('advocme_session'))!
    expect(set).toContain('HttpOnly')

    // 2. Uma requisição nova (o "reabrir o navegador") continua autenticada só
    //    com o cookie guardado.
    const me = await nav.ir('/me')
    expect(me.status).toBe(200)
    expect(await me.json()).toEqual({ userId: 'u1' })

    // 3. Escrever sem o token anti-CSRF é recusado...
    expect((await nav.ir('/salvar', { method: 'POST' })).status).toBe(403)

    // 4. ...e com ele, passa.
    const ok = await nav.ir('/salvar', {
      method: 'POST',
      headers: { 'x-csrf-token': corpo.csrfToken },
    })
    expect(ok.status).toBe(200)

    // 5. Sair apaga o cookie no navegador e a sessão no servidor.
    expect((await nav.ir('/logout', { method: 'POST' })).status).toBe(204)
    expect(nav.cookie('advocme_session')).toBeUndefined()
    expect((await nav.ir('/me')).status).toBe(401)
  })

  it('o cookie de outro navegador não serve depois do logout', async () => {
    const nav = new Navegador()
    await nav.ir('/login', { method: 'POST' })
    const roubado = nav.cookie('advocme_session')!
    await nav.ir('/logout', { method: 'POST' })

    const ladrao = await fetch(`${base}/me`, {
      headers: { Origin: ORIGEM, Cookie: `advocme_session=${roubado}` },
    })
    expect(ladrao.status).toBe(401)
  })

  it('um pedido vindo de outro site é barrado', async () => {
    const nav = new Navegador()
    const login = await nav.ir('/login', { method: 'POST' })
    const { csrfToken } = (await login.json()) as { csrfToken: string }

    const deFora = await fetch(`${base}/salvar`, {
      method: 'POST',
      headers: {
        Origin: 'https://site-do-atacante.com',
        Cookie: `advocme_session=${nav.cookie('advocme_session')}`,
        'x-csrf-token': csrfToken,
      },
    })
    expect(deFora.status).toBe(403)
  })
})
