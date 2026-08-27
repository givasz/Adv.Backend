// O painel de moderação — quem decide o que sai do ar.
//
// É o alvo mais valioso da plataforma: quem entrar aqui derruba perfis. Estes
// testes existem para que a sessão dele não volte a ser um token que qualquer
// script da página lê, para que uma ação de moderação nunca seja disparada de
// outro site com a sessão de quem está logado, e — o que esta fase acrescentou —
// para que **quem responde suporte não consiga tirar um perfil do ar** e para
// que **nenhuma decisão fique sem autor**.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ForbiddenException, UnauthorizedException } from '@nestjs/common'

process.env.FRONTEND_ORIGIN = 'https://app.exemplo.com'

import { AdminService } from './admin.service'
import { ADMIN_COOKIE, ADMIN_COOKIE_PATH, ADMIN_CSRF_COOKIE } from './admin-auth'
import { sessionContext } from '../auth/session-context'
import { hashPassword } from '../auth/user-auth'
import { codigoTotp, novoSegredoTotp } from './totp'

const ORIGEM = 'https://app.exemplo.com'
const SENHA = 'senha-do-painel-longa'

// ---- Banco de mentira -------------------------------------------------------
//
// Um Prisma falso, e não um banco de verdade, porque o que está sob teste é a
// decisão (quem pode o quê), não o SQL.

interface Linha {
  [k: string]: unknown
}

function combina(linha: Linha, where: Linha | undefined): boolean {
  if (!where) return true
  return Object.entries(where).every(([campo, cond]) => {
    const v = linha[campo]
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>
      if ('lt' in c) return (v as Date) < (c.lt as Date)
      if ('gt' in c) return (v as Date) > (c.gt as Date)
      if ('not' in c) return v !== c.not
      if ('in' in c) return (c.in as unknown[]).includes(v)
    }
    return v === cond
  })
}

function fakePrisma() {
  const admins: Linha[] = []
  const sessions: Linha[] = []
  const actions: Linha[] = []
  let seq = 0

  const acharAdmin = (where: Linha) =>
    admins.find((a) => (where.id ? a.id === where.id : a.email === where.email))

  return {
    _admins: admins,
    _sessions: sessions,
    _actions: actions,
    adminUser: {
      count: async ({ where }: { where?: Linha } = {}) => admins.filter((a) => combina(a, where)).length,
      // Cópias, como o Prisma de verdade devolve. Enquanto era a mesma
      // referência, um teste do "antes" do histórico lia o depois e passava.
      findUnique: async ({ where }: { where: Linha }) => {
        const a = acharAdmin(where)
        return a ? { ...a } : null
      },
      findMany: async () => admins.map((a) => ({ ...a, _count: { sessions: sessions.filter((s) => s.adminId === a.id).length } })),
      create: async ({ data }: { data: Linha }) => {
        const a: Linha = {
          id: `adm${++seq}`,
          active: true,
          totpEnabled: false,
          totpSecret: null,
          createdAt: new Date(),
          lastLoginAt: null,
          role: 'support',
          ...data,
        }
        admins.push(a)
        return { ...a }
      },
      update: async ({ where, data }: { where: Linha; data: Linha }) => {
        const a = acharAdmin(where)
        if (!a) throw new Error('não achou')
        Object.assign(a, data)
        return { ...a }
      },
    },
    adminSession: {
      create: async ({ data }: { data: Linha }) => {
        sessions.push({ ...data })
        return data
      },
      findUnique: async ({ where, include }: { where: Linha; include?: Linha }) => {
        const s = sessions.find((x) => x.id === where.id)
        if (!s) return null
        return include?.admin ? { ...s, admin: admins.find((a) => a.id === s.adminId) ?? null } : s
      },
      updateMany: async ({ where, data }: { where: Linha; data: Linha }) => {
        const alvo = sessions.filter((s) => combina(s, where))
        alvo.forEach((s) => Object.assign(s, data))
        return { count: alvo.length }
      },
      deleteMany: async ({ where }: { where: Linha }) => {
        const alvo = sessions.filter((s) => combina(s, where))
        for (const s of alvo) sessions.splice(sessions.indexOf(s), 1)
        return { count: alvo.length }
      },
    },
    adminAction: {
      create: async ({ data }: { data: Linha }) => {
        actions.push(data)
        return data
      },
      findMany: async () => [...actions].reverse(),
    },
  }
}

// ---- Requisição de mentira --------------------------------------------------

interface RespostaFalsa {
  headers: Record<string, string | string[]>
  getHeader(nome: string): string | string[] | undefined
  setHeader(nome: string, valor: string | string[]): void
}

function pedido(
  opts: { method?: string; cookies?: Record<string, string>; origin?: string | null; csrf?: string } = {},
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

// ---- Cenário ----------------------------------------------------------------

let prisma: ReturnType<typeof fakePrisma>
let admin: AdminService

beforeEach(() => {
  vi.useRealTimers()
  prisma = fakePrisma()
  admin = new AdminService(prisma as never)
})

async function criarConta(role: string, extra: Linha = {}) {
  return prisma.adminUser.create({
    data: {
      email: `${role}@exemplo.com`,
      name: role,
      role,
      passwordHash: hashPassword(SENHA),
      ...extra,
    },
  })
}

/** Entra no painel com uma conta e devolve os cookies com que o navegador voltaria. */
async function entrar(role = 'owner', totp?: string) {
  const conta = prisma._admins.find((a) => a.role === role) ?? (await criarConta(role))
  const { req, res } = pedido({ method: 'POST' })
  const aberta = await admin.entrar(req, {
    username: conta.email as string,
    password: SENHA,
    totp,
  })
  return { conta, aberta, cookies: cookiesDe(res), linhas: setCookies(res) }
}

/**
 * Entra com o segundo fator já configurado.
 *
 * Existe porque `owner` e `moderator` entram com o fator PENDENTE, e nesse
 * estado toda decisão é recusada — o que fazia um teste de CSRF "passar" pelo
 * motivo errado: a exceção vinha do segundo fator, não da falta do token.
 */
async function entrarPronto(role = 'owner') {
  const segredo = novoSegredoTotp()
  await criarConta(role, { totpEnabled: true, totpSecret: segredo })
  return entrar(role, codigoTotp(segredo, Math.floor(Date.now() / 1000 / 30)))
}

// ---- Testes -----------------------------------------------------------------

describe('sessão do painel', () => {
  it('o cookie é HttpOnly e vale só em /api/admin', async () => {
    const { linhas } = await entrar()
    const sessao = linhas.find((l) => l.startsWith(ADMIN_COOKIE))!
    expect(sessao).toContain('HttpOnly')
    expect(sessao).toContain(`Path=${ADMIN_COOKIE_PATH}`)
    // O cookie do painel não pode viajar junto de uma visita a perfil público.
    expect(sessao).not.toContain('Path=/;')
  })

  it('nenhuma credencial volta no corpo', async () => {
    const { aberta } = await entrar()
    expect(Object.keys(aberta).sort()).toEqual(['csrfToken', 'expiresAt', 'name', 'role', 'totpPendente'])
  })

  it('sobrevive a um restart — a sessão está no banco, não na memória do processo', async () => {
    const { cookies } = await entrar('support')
    // Outro processo, mesmo banco.
    const outro = new AdminService(prisma as never)
    expect(await outro.atual(pedido({ cookies }).req)).not.toBeNull()
  })

  it('id certo com segredo errado não autentica', async () => {
    const { cookies } = await entrar()
    const id = cookies[ADMIN_COOKIE]!.split('.')[0]
    const forjado = { [ADMIN_COOKIE]: `${id}.segredo-inventado-mas-longo` }
    expect(await admin.atual(pedido({ cookies: forjado }).req)).toBeNull()
  })

  it('sem cookie nenhum, 403', async () => {
    await expect(admin.exigir(pedido().req, 'moderacao:ler')).rejects.toThrow(ForbiddenException)
  })

  it('a sessão vence sozinha', async () => {
    const { cookies } = await entrar('support')
    expect(await admin.atual(pedido({ cookies }).req)).not.toBeNull()
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000)
    expect(await admin.atual(pedido({ cookies }).req)).toBeNull()
  })

  it('desativar a conta derruba a sessão na hora', async () => {
    const { conta, cookies } = await entrar('support')
    expect(await admin.atual(pedido({ cookies }).req)).not.toBeNull()
    await prisma.adminUser.update({ where: { id: conta.id }, data: { active: false } })
    expect(await admin.atual(pedido({ cookies }).req)).toBeNull()
  })
})

describe('entrar', () => {
  it('senha errada é recusada', async () => {
    await criarConta('owner')
    await expect(
      admin.entrar(pedido({ method: 'POST' }).req, { username: 'owner@exemplo.com', password: 'errada' }),
    ).rejects.toThrow(UnauthorizedException)
  })

  it('conta desativada responde igual a senha errada', async () => {
    await criarConta('support', { active: false })
    await expect(
      admin.entrar(pedido({ method: 'POST' }).req, { username: 'support@exemplo.com', password: SENHA }),
    ).rejects.toThrow(/Usuário ou senha inválidos/)
  })

  it('com segundo fator ligado, senha sozinha não entra', async () => {
    const segredo = novoSegredoTotp()
    await criarConta('moderator', { totpEnabled: true, totpSecret: segredo })
    const entrada = { username: 'moderator@exemplo.com', password: SENHA }
    await expect(admin.entrar(pedido({ method: 'POST' }).req, entrada)).rejects.toThrow(
      /Código de verificação/,
    )
    const codigo = codigoTotp(segredo, Math.floor(Date.now() / 1000 / 30))
    await expect(
      admin.entrar(pedido({ method: 'POST' }).req, { ...entrada, totp: codigo }),
    ).resolves.toMatchObject({ role: 'moderator' })
  })

  it('a credencial do .env só vale enquanto NÃO existe administrador', async () => {
    // Porta de emergência aberta: é assim que o primeiro nasce.
    const zero = pedido({ method: 'POST' })
    await expect(
      admin.entrar(zero.req, { username: 'admin', password: 'dev-admin-123' }),
    ).resolves.toMatchObject({ role: 'owner' })

    // Criado o primeiro, a porta fecha — sem deploy, sem variável para lembrar.
    await criarConta('owner')
    await expect(
      admin.entrar(pedido({ method: 'POST' }).req, { username: 'admin', password: 'dev-admin-123' }),
    ).rejects.toThrow(UnauthorizedException)
  })

  it('a sessão de emergência aberta antes também para de valer', async () => {
    const abertura = pedido({ method: 'POST' })
    await admin.entrar(abertura.req, { username: 'admin', password: 'dev-admin-123' })
    const cookies = cookiesDe(abertura.res)
    expect(await admin.atual(pedido({ cookies }).req)).not.toBeNull()
    await criarConta('owner')
    expect(await admin.atual(pedido({ cookies }).req)).toBeNull()
  })
})

describe('sair do painel', () => {
  it('encerra de verdade e manda apagar os dois cookies', async () => {
    const { cookies } = await entrar('support')
    const saida = pedido({ method: 'POST', cookies })
    await admin.sair(saida.req)

    const apagados = setCookies(saida.res)
    expect(apagados.find((l) => l.startsWith(ADMIN_COOKIE))).toContain('Max-Age=0')
    expect(apagados.find((l) => l.startsWith(ADMIN_CSRF_COOKIE))).toContain('Max-Age=0')
    // Um cookie copiado antes do logout não vale mais.
    expect(await admin.atual(pedido({ cookies }).req)).toBeNull()
  })

  it('não dá para derrubar a sessão alheia sabendo só o id', async () => {
    const { cookies } = await entrar('support')
    const id = cookies[ADMIN_COOKIE]!.split('.')[0]
    await admin.sair(
      pedido({ method: 'POST', cookies: { [ADMIN_COOKIE]: `${id}.segredo-inventado-mas-longo` } }).req,
    )
    expect(await admin.atual(pedido({ cookies }).req)).not.toBeNull()
  })

  it('sair sem cookie não explode', async () => {
    await expect(admin.sair(pedido({ method: 'POST' }).req)).resolves.toBeUndefined()
  })
})

describe('CSRF no painel', () => {
  it('ação que MODERA sem o token é recusada', async () => {
    const { cookies } = await entrarPronto()
    await expect(
      admin.exigir(pedido({ method: 'POST', cookies }).req, 'moderacao:decidir'),
    ).rejects.toThrow(/Atualize a página/)
  })

  it('com o token da sessão, passa', async () => {
    const { cookies } = await entrarPronto()
    const req = pedido({ method: 'POST', cookies, csrf: cookies[ADMIN_CSRF_COOKIE] }).req
    await expect(admin.exigir(req, 'moderacao:decidir')).resolves.toMatchObject({ role: 'owner' })
  })

  it('origem de outro site é barrada mesmo com o token', async () => {
    const { cookies } = await entrarPronto()
    const req = pedido({
      method: 'POST',
      cookies,
      csrf: cookies[ADMIN_CSRF_COOKIE],
      origin: 'https://site-do-atacante.com',
    }).req
    await expect(admin.exigir(req, 'moderacao:decidir')).rejects.toThrow(/origem/)
  })

  it('leitura (GET) não precisa de token', async () => {
    const { cookies } = await entrarPronto()
    await expect(admin.exigir(pedido({ cookies }).req, 'moderacao:ler')).resolves.toBeTruthy()
  })
})

describe('papéis', () => {
  it('quem responde suporte NÃO tira perfil do ar', async () => {
    const { cookies } = await entrar('support')
    const req = pedido({ method: 'POST', cookies, csrf: cookies[ADMIN_CSRF_COOKIE] }).req
    // Consulta a fila: pode.
    await expect(admin.exigir(pedido({ cookies }).req, 'moderacao:ler')).resolves.toBeTruthy()
    // Decide: não.
    await expect(admin.exigir(req, 'moderacao:decidir')).rejects.toThrow(/papel no painel/)
  })

  it('só o responsável mexe em administradores', async () => {
    const mod = await entrar('moderator', undefined)
    const req = pedido({ method: 'POST', cookies: mod.cookies, csrf: mod.cookies[ADMIN_CSRF_COOKIE] }).req
    await expect(admin.exigir(req, 'admins:gerir')).rejects.toThrow(ForbiddenException)
  })

  it('só leitura não decide nada', async () => {
    const { cookies } = await entrar('readonly')
    const req = pedido({ method: 'POST', cookies, csrf: cookies[ADMIN_CSRF_COOKIE] }).req
    await expect(admin.exigir(req, 'suporte:responder')).rejects.toThrow(ForbiddenException)
    await expect(admin.exigir(pedido({ cookies }).req, 'suporte:ler')).resolves.toBeTruthy()
  })

  it('token de serviço entra como só leitura — nunca decide', async () => {
    vi.stubEnv('ADMIN_TOKEN', 'token-longo-de-servico-para-scripts-1234')
    const token = 'token-longo-de-servico-para-scripts-1234'
    await expect(admin.exigir(pedido().req, 'moderacao:ler', token)).resolves.toMatchObject({
      role: 'readonly',
    })
    await expect(
      admin.exigir(pedido({ method: 'POST' }).req, 'moderacao:decidir', token),
    ).rejects.toThrow(ForbiddenException)
    vi.unstubAllEnvs()
  })
})

describe('segundo fator pendente', () => {
  it('quem decide entra, consulta, mas não tira nada do ar antes de configurar', async () => {
    const { cookies, aberta } = await entrar('moderator')
    expect(aberta.totpPendente).toBe(true)
    // Consultar a fila continua liberado: dá para trabalhar enquanto configura.
    await expect(admin.exigir(pedido({ cookies }).req, 'moderacao:ler')).resolves.toBeTruthy()
    const req = pedido({ method: 'POST', cookies, csrf: cookies[ADMIN_CSRF_COOKIE] }).req
    await expect(admin.exigir(req, 'moderacao:decidir')).rejects.toThrow(/segundo fator/)
  })

  it('configurado, as decisões liberam', async () => {
    const { cookies } = await entrar('moderator')
    const quem = (await admin.atual(pedido({ cookies }).req))!
    const { segredo } = await admin.iniciarTotp(quem)
    const limpo = segredo.replace(/\s/g, '')
    await admin.ligarTotp(quem, codigoTotp(limpo, Math.floor(Date.now() / 1000 / 30)))

    const req = pedido({ method: 'POST', cookies, csrf: cookies[ADMIN_CSRF_COOKIE] }).req
    await expect(admin.exigir(req, 'moderacao:decidir')).resolves.toBeTruthy()
  })

  it('recomeçar a configuração NÃO invalida o que o celular já leu', async () => {
    // Enquanto cada chamada sorteava um segredo novo, recarregar a página
    // substituía em silêncio o que o aplicativo acabara de ler — e a partir dali
    // nenhum código funcionava, para sempre, sem nada na tela explicando.
    const { cookies } = await entrar('moderator')
    const quem = (await admin.atual(pedido({ cookies }).req))!
    const primeiro = await admin.iniciarTotp(quem)
    const segundo = await admin.iniciarTotp(quem)
    expect(segundo.segredo).toBe(primeiro.segredo)

    // E o código gerado a partir do QR lido na PRIMEIRA vez continua valendo.
    const limpo = primeiro.segredo.replace(/\s/g, '')
    await expect(
      admin.ligarTotp(quem, codigoTotp(limpo, Math.floor(Date.now() / 1000 / 30))),
    ).resolves.toEqual({ ok: true })
  })

  it('com o segundo fator já ligado, não dá para recomeçar', async () => {
    const segredo = novoSegredoTotp()
    await criarConta('owner', { totpEnabled: true, totpSecret: segredo })
    const { cookies } = await entrar('owner', codigoTotp(segredo, Math.floor(Date.now() / 1000 / 30)))
    const quem = (await admin.atual(pedido({ cookies }).req))!
    await expect(admin.iniciarTotp(quem)).rejects.toThrow(/já está ligado/)
  })

  it('quem só atende suporte não é obrigado a configurar', async () => {
    const { aberta, cookies } = await entrar('support')
    expect(aberta.totpPendente).toBe(false)
    const req = pedido({ method: 'POST', cookies, csrf: cookies[ADMIN_CSRF_COOKIE] }).req
    await expect(admin.exigir(req, 'suporte:responder')).resolves.toBeTruthy()
  })
})

describe('o registro', () => {
  it('entrar no painel já deixa rastro, com nome e papel', async () => {
    await entrar('owner')
    const linha = prisma._actions.find((a) => a.action === 'sessao.abrir')
    expect(linha).toBeTruthy()
    expect(linha!.adminRole).toBe('owner')
    expect(linha!.adminLabel).toBe('owner')
  })

  it('guarda a impressão digital do IP, nunca o endereço', async () => {
    await criarConta('owner')
    await admin.entrar(
      pedido({ method: 'POST' }).req,
      { username: 'owner@exemplo.com', password: SENHA },
      '203.0.113.9',
    )
    const linha = prisma._actions.find((a) => a.action === 'sessao.abrir')!
    expect(linha.ip).not.toContain('203.0.113')
    expect(String(linha.ip)).toHaveLength(12)
  })

  it('decisão sem motivo escrito é recusada antes de acontecer', async () => {
    expect(() => admin.exigirMotivo('')).toThrow(/motivo/)
    expect(() => admin.exigirMotivo('ok')).toThrow(/motivo/)
    expect(admin.exigirMotivo('  bio com promessa de resultado  ')).toBe(
      'bio com promessa de resultado',
    )
  })

  it('um erro ao registrar não desfaz a decisão já aplicada', async () => {
    const quem = { id: null, label: 'x', role: 'owner' as const, sessionId: null, totpPendente: false, emergencia: false }
    prisma.adminAction.create = async () => {
      throw new Error('banco fora')
    }
    await expect(admin.registrar(quem, { action: 'moderacao.restrict' })).resolves.toBeUndefined()
  })
})

describe('travas da gestão de administradores', () => {
  async function comoResponsavel() {
    const { cookies } = await entrar('owner')
    return (await admin.atual(pedido({ cookies }).req))!
  }

  it('ninguém muda o próprio papel nem se desativa', async () => {
    const quem = await comoResponsavel()
    await expect(
      admin.atualizarAdmin(quem, quem.id!, { role: 'support', reason: 'quero sair' }),
    ).rejects.toThrow(/próprio papel/)
    await expect(
      admin.atualizarAdmin(quem, quem.id!, { active: false, reason: 'quero sair' }),
    ).rejects.toThrow(/próprio papel/)
  })

  it('o último responsável ativo não pode ser rebaixado por outro', async () => {
    const quem = await comoResponsavel()
    const segundo = await criarConta('moderator')
    // O moderador tenta rebaixar o único responsável (pela via do serviço).
    await expect(
      admin.atualizarAdmin(
        { ...quem, id: segundo.id as string },
        quem.id!,
        { role: 'support', reason: 'reorganização' },
      ),
    ).rejects.toThrow(/único responsável/)
  })

  it('desativar alguém derruba as sessões dele no mesmo ato', async () => {
    const quem = await comoResponsavel()
    const outro = await entrar('support')
    expect(prisma._sessions.filter((s) => s.adminId === outro.conta.id)).toHaveLength(1)
    await admin.atualizarAdmin(quem, outro.conta.id as string, {
      active: false,
      reason: 'saiu da equipe',
    })
    expect(prisma._sessions.filter((s) => s.adminId === outro.conta.id)).toHaveLength(0)
    expect(await admin.atual(pedido({ cookies: outro.cookies }).req)).toBeNull()
  })

  it('mudança de papel exige motivo, e ele vai para o histórico', async () => {
    const quem = await comoResponsavel()
    const outro = await criarConta('support')
    await expect(
      admin.atualizarAdmin(quem, outro.id as string, { role: 'moderator' }),
    ).rejects.toThrow(/motivo/)
    await admin.atualizarAdmin(quem, outro.id as string, {
      role: 'moderator',
      reason: 'assumiu a fila de denúncias',
    })
    const linha = prisma._actions.find((a) => a.action === 'admin.editar')!
    expect(linha.reason).toBe('assumiu a fila de denúncias')
    expect(JSON.parse(linha.before as string).role).toBe('support')
    expect(JSON.parse(linha.after as string).role).toBe('moderator')
  })

  it('senha curta não vira administrador', async () => {
    const quem = await comoResponsavel()
    await expect(
      admin.criarAdmin(quem, { email: 'novo@exemplo.com', name: 'Novo', password: 'curta', role: 'support' }),
    ).rejects.toThrow(/12 caracteres/)
  })

  it('trocar a própria senha derruba as OUTRAS sessões, não a atual', async () => {
    const { cookies } = await entrar('owner')
    const quem = (await admin.atual(pedido({ cookies }).req))!
    // Um segundo aparelho da mesma pessoa.
    const outroAparelho = pedido({ method: 'POST' })
    await admin.entrar(outroAparelho.req, { username: 'owner@exemplo.com', password: SENHA })
    expect(prisma._sessions.filter((s) => s.adminId === quem.id)).toHaveLength(2)

    await admin.trocarPropriaSenha(quem, SENHA, 'outra-senha-bem-longa-aqui')
    const restantes = prisma._sessions.filter((s) => s.adminId === quem.id)
    expect(restantes).toHaveLength(1)
    expect(restantes[0]!.id).toBe(quem.sessionId)
  })
})
