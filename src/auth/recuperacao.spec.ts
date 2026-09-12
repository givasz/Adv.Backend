// "Esqueci minha senha" e confirmação de e-mail. O que não pode regredir:
//
//   • pedido para e-mail sem conta não deixa rastro nenhum;
//   • o banco guarda o hash do link, nunca o link;
//   • pedir de novo mata o link anterior;
//   • o link funciona uma vez, vence, e só vale para o endereço ao qual foi;
//   • senha fraca recusada não gasta o link;
//   • redefinir derruba todas as sessões e avisa por e-mail.

import { BadRequestException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { AuthService } from './auth.service'
import { hashCredencial, hashPassword, verifyPassword } from './user-auth'

const SENHA_VELHA = 'Marina#Sales2026'
const SENHA_NOVA = 'Ceramica-Vento-38-Azul'
const req = {} as never

async function montar(opts: { correioAtivo?: boolean } = {}) {
  const tokens: Record<string, any>[] = []
  const users = [
    {
      id: 'u1',
      email: 'marina@exemplo.com',
      password: await hashPassword(SENHA_VELHA),
      emailVerifiedAt: null as Date | null,
      termsVersion: '',
      profile: { name: 'Marina', plan: 'free', planStatus: 'active', currentPeriodEnd: null, graceUntil: null },
    },
  ]
  const prisma: any = {
    user: {
      findUnique: vi.fn(
        async ({ where }: any) =>
          users.find((u) => (where.id ? u.id === where.id : u.email === where.email)) ?? null,
      ),
      update: vi.fn(async ({ where, data }: any) => Object.assign(users.find((u) => u.id === where.id)!, data)),
    },
    emailToken: {
      deleteMany: vi.fn(async ({ where }: any) => {
        const antes = tokens.length
        for (let i = tokens.length - 1; i >= 0; i--) {
          const t = tokens[i]!
          if (t.userId === where.userId && t.tipo === where.tipo && t.usadoEm === where.usadoEm) tokens.splice(i, 1)
        }
        return { count: antes - tokens.length }
      }),
      create: vi.fn(async ({ data }: any) => {
        const t = { id: `t${tokens.length + 1}-${Math.random()}`, usadoEm: null, ...data }
        tokens.push(t)
        return t
      }),
      findUnique: vi.fn(async ({ where }: any) => tokens.find((t) => t.tokenHash === where.tokenHash) ?? null),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const t = tokens.find((x) => x.id === where.id && x.usadoEm === null)
        if (t) Object.assign(t, data)
        return { count: t ? 1 : 0 }
      }),
    },
  }
  const sessions: any = {
    abrir: vi.fn(async () => ({ expiresAt: 1, csrfToken: 'c', remember: true })),
    encerrarTodas: vi.fn(async () => 2),
  }
  const correio: any = { ativo: opts.correioAtivo ?? true, enfileirar: vi.fn(async () => true) }
  const svc = new AuthService(prisma, sessions, correio)
  const avisos = (modelo: string) =>
    correio.enfileirar.mock.calls.map((c: any[]) => c[0]).filter((a: any) => a.modelo === modelo)
  return { svc, users, tokens, sessions, correio, prisma, avisos }
}

describe('esqueci minha senha — o pedido', () => {
  it('e-mail sem conta: nenhum link, nenhum aviso', async () => {
    const { svc, tokens, correio } = await montar()
    await svc.pedirRedefinicao('ninguem@exemplo.com')
    expect(tokens).toHaveLength(0)
    expect(correio.enfileirar).not.toHaveBeenCalled()
  })

  it('conta existente: o banco guarda só o hash, e o link vai por e-mail com prazo de 1 hora', async () => {
    const { svc, tokens, avisos } = await montar()
    await svc.pedirRedefinicao('  MARINA@exemplo.com ')
    const [aviso] = avisos('redefinir-senha')
    expect(aviso.para).toBe('marina@exemplo.com')
    expect(tokens).toHaveLength(1)
    expect(tokens[0]!.tokenHash).toBe(hashCredencial(aviso.dados.token))
    expect(JSON.stringify(tokens)).not.toContain(aviso.dados.token)
    const minutos = (aviso.validoAte.getTime() - Date.now()) / 60_000
    expect(minutos).toBeGreaterThan(59)
    expect(minutos).toBeLessThanOrEqual(60)
  })

  it('pedir de novo mata o link anterior', async () => {
    const { svc, avisos } = await montar()
    await svc.pedirRedefinicao('marina@exemplo.com')
    await svc.pedirRedefinicao('marina@exemplo.com')
    const [primeiro, segundo] = avisos('redefinir-senha')
    await expect(svc.redefinirSenha(req, primeiro.dados.token, SENHA_NOVA)).rejects.toThrow(BadRequestException)
    await expect(svc.redefinirSenha(req, segundo.dados.token, SENHA_NOVA)).resolves.toEqual({ ok: true })
  })

  it('correio desligado: nada acontece', async () => {
    const { svc, tokens } = await montar({ correioAtivo: false })
    await svc.pedirRedefinicao('marina@exemplo.com')
    expect(tokens).toHaveLength(0)
  })
})

describe('esqueci minha senha — o link', () => {
  async function comLink() {
    const m = await montar()
    await m.svc.pedirRedefinicao('marina@exemplo.com')
    return { ...m, token: m.avisos('redefinir-senha')[0].dados.token as string }
  }

  it('troca a senha, derruba todas as sessões, confirma o e-mail e avisa', async () => {
    const { svc, users, sessions, token, avisos } = await comLink()
    await svc.redefinirSenha(req, token, SENHA_NOVA)
    expect(await verifyPassword(SENHA_NOVA, users[0]!.password)).toBe(true)
    expect(sessions.encerrarTodas).toHaveBeenCalledWith('u1', req)
    expect(sessions.abrir).not.toHaveBeenCalled()
    expect(users[0]!.emailVerifiedAt).toBeInstanceOf(Date)
    expect(avisos('senha-alterada')[0].dados.porLink).toBe(true)
  })

  it('funciona uma vez só', async () => {
    const { svc, token } = await comLink()
    await svc.redefinirSenha(req, token, SENHA_NOVA)
    await expect(svc.redefinirSenha(req, token, 'Outra-Senha-Forte-77')).rejects.toThrow(BadRequestException)
  })

  it('senha fraca recusada não gasta o link', async () => {
    const { svc, token } = await comLink()
    await expect(svc.redefinirSenha(req, token, '123')).rejects.toThrow(BadRequestException)
    await expect(svc.redefinirSenha(req, token, SENHA_NOVA)).resolves.toEqual({ ok: true })
  })

  it('vencido não vale', async () => {
    const { svc, token, tokens } = await comLink()
    tokens[0]!.expiraEm = new Date(Date.now() - 1)
    await expect(svc.redefinirSenha(req, token, SENHA_NOVA)).rejects.toThrow(BadRequestException)
  })

  it('não vale se o e-mail da conta mudou depois do envio', async () => {
    const { svc, token, users } = await comLink()
    users[0]!.email = 'novo@exemplo.com'
    await expect(svc.redefinirSenha(req, token, SENHA_NOVA)).rejects.toThrow(BadRequestException)
  })

  it('token de formato estranho nem chega ao banco', async () => {
    const { svc, prisma } = await montar()
    await expect(svc.redefinirSenha(req, "' OR 1=1 --", SENHA_NOVA)).rejects.toThrow(BadRequestException)
    expect(prisma.emailToken.findUnique).not.toHaveBeenCalled()
  })
})

describe('confirmação de e-mail', () => {
  it('o link confirma a conta, uma vez só', async () => {
    const { svc, users, avisos } = await montar()
    await svc.reenviarConfirmacao('u1')
    const token = avisos('confirmar-email')[0].dados.token
    await svc.confirmarEmail(token)
    expect(users[0]!.emailVerifiedAt).toBeInstanceOf(Date)
    await expect(svc.confirmarEmail(token)).rejects.toThrow(BadRequestException)
  })

  it('link de redefinição não confirma e-mail por engano (e vice-versa)', async () => {
    const { svc, avisos } = await montar()
    await svc.pedirRedefinicao('marina@exemplo.com')
    await expect(svc.confirmarEmail(avisos('redefinir-senha')[0].dados.token)).rejects.toThrow(BadRequestException)
  })

  it('quem já confirmou não recebe outro link', async () => {
    const { svc, users, correio } = await montar()
    users[0]!.emailVerifiedAt = new Date()
    expect(await svc.reenviarConfirmacao('u1')).toEqual({ enviado: false, jaConfirmado: true })
    expect(correio.enfileirar).not.toHaveBeenCalled()
  })

  it('a tela só pede confirmação quando o correio pode mandar o link', async () => {
    expect((await (await montar()).svc.me('u1')).emailPending).toBe(true)
    expect((await (await montar({ correioAtivo: false })).svc.me('u1')).emailPending).toBe(false)
  })
})

describe('trocar a senha logado', () => {
  it('também avisa por e-mail — é a primeira notícia de quem perdeu a conta', async () => {
    const { svc, avisos } = await montar()
    await svc.trocarSenha(req, 'u1', SENHA_VELHA, SENHA_NOVA)
    expect(avisos('senha-alterada')[0].dados.porLink).toBe(false)
  })
})
