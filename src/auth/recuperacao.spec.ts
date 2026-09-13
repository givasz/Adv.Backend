// "Esqueci minha senha" e confirmação de e-mail. O que não pode regredir:
//
//   • pedido para e-mail sem conta não deixa rastro nenhum;
//   • o banco guarda o hash do link, nunca o link;
//   • pedir de novo mata o link anterior — mas só quando um link novo sai;
//   • no máximo um link por minuto e cinco por dia por conta, contados na fila
//     gravada (e não na memória do processo, que zera a cada deploy);
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
const MINUTO = 60_000
const DIA = 24 * 60 * MINUTO

async function montar(opts: { correioAtivo?: boolean } = {}) {
  const tokens: Record<string, any>[] = []
  // O que o correio recebeu, como a fila (MailOutbox) guardaria.
  const fila: { userId: string | null; modelo: string; createdAt: Date }[] = []
  const users = [
    {
      id: 'u1',
      email: 'marina@exemplo.com',
      password: await hashPassword(SENHA_VELHA),
      emailVerifiedAt: null as Date | null,
      termsVersion: '',
      googleSub: null as string | null,
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
    mailOutbox: {
      findMany: vi.fn(async ({ where, take }: any) =>
        fila
          .filter((l) => l.userId === where.userId && l.modelo === where.modelo && l.createdAt >= where.createdAt.gte)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, take)
          .map((l) => ({ createdAt: l.createdAt })),
      ),
    },
  }
  const sessions: any = {
    abrir: vi.fn(async () => ({ expiresAt: 1, csrfToken: 'c', remember: true })),
    encerrarTodas: vi.fn(async () => 2),
  }
  const correio: any = {
    ativo: opts.correioAtivo ?? true,
    enfileirar: vi.fn(async (a: any) => {
      fila.push({ userId: a.userId ?? null, modelo: a.modelo, createdAt: new Date() })
      return true
    }),
  }
  const svc = new AuthService(prisma, sessions, correio)
  const avisos = (modelo: string) =>
    correio.enfileirar.mock.calls.map((c: any[]) => c[0]).filter((a: any) => a.modelo === modelo)
  /** Faz o tempo andar para a fila: tudo o que já saiu fica `ms` mais velho. */
  const envelhecer = (ms: number) => {
    for (const l of fila) l.createdAt = new Date(l.createdAt.getTime() - ms)
  }
  return { svc, users, tokens, sessions, correio, prisma, avisos, envelhecer }
}

/** Status HTTP de uma exceção do Nest, para conferir o 429 sem depender do texto. */
function status(e: unknown): number | undefined {
  return (e as { getStatus?: () => number })?.getStatus?.()
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

  it('pedir de novo (passado um minuto) mata o link anterior', async () => {
    const { svc, avisos, envelhecer } = await montar()
    await svc.pedirRedefinicao('marina@exemplo.com')
    envelhecer(2 * MINUTO)
    await svc.pedirRedefinicao('marina@exemplo.com')
    const [primeiro, segundo] = avisos('redefinir-senha')
    await expect(svc.redefinirSenha(req, primeiro.dados.token, SENHA_NOVA)).rejects.toThrow(BadRequestException)
    await expect(svc.redefinirSenha(req, segundo.dados.token, SENHA_NOVA)).resolves.toEqual({ ok: true })
  })

  it('pedir de novo em menos de um minuto não manda outro — e o link que já saiu segue valendo', async () => {
    // O clique impaciente: sem esta trava, o segundo pedido mataria o link que
    // ainda está a caminho, e o primeiro e-mail chegaria com um botão morto.
    const { svc, avisos, tokens } = await montar()
    await svc.pedirRedefinicao('marina@exemplo.com')
    await svc.pedirRedefinicao('marina@exemplo.com')
    expect(avisos('redefinir-senha')).toHaveLength(1)
    expect(tokens).toHaveLength(1)
    await expect(svc.redefinirSenha(req, avisos('redefinir-senha')[0].dados.token, SENHA_NOVA)).resolves.toEqual({
      ok: true,
    })
  })

  it('cinco por dia: o sexto pedido não manda nada, e o último link continua valendo', async () => {
    const { svc, avisos, envelhecer } = await montar()
    for (let i = 0; i < 5; i++) {
      await svc.pedirRedefinicao('marina@exemplo.com')
      envelhecer(10 * MINUTO)
    }
    await svc.pedirRedefinicao('marina@exemplo.com')
    const enviados = avisos('redefinir-senha')
    expect(enviados).toHaveLength(5)
    await expect(svc.redefinirSenha(req, enviados[4].dados.token, SENHA_NOVA)).resolves.toEqual({ ok: true })
  })

  it('passadas 24 horas, volta a poder pedir', async () => {
    const { svc, avisos, envelhecer } = await montar()
    for (let i = 0; i < 5; i++) {
      await svc.pedirRedefinicao('marina@exemplo.com')
      envelhecer(10 * MINUTO)
    }
    envelhecer(DIA)
    await svc.pedirRedefinicao('marina@exemplo.com')
    expect(avisos('redefinir-senha')).toHaveLength(6)
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

  it('pedir outro em menos de um minuto: recusa dizendo quando dá, e o link anterior segue valendo', async () => {
    // Aqui a pessoa está logada — dizer o motivo não entrega nada a ninguém.
    const { svc, users, avisos } = await montar()
    await svc.reenviarConfirmacao('u1')
    const erro = await svc.reenviarConfirmacao('u1').catch((e: unknown) => e)
    expect(status(erro)).toBe(429)
    expect(String((erro as Error).message)).toMatch(/um minuto/)
    await svc.confirmarEmail(avisos('confirmar-email')[0].dados.token)
    expect(users[0]!.emailVerifiedAt).toBeInstanceOf(Date)
  })

  it('cinco por dia: o sexto recusa e manda voltar amanhã', async () => {
    const { svc, avisos, envelhecer } = await montar()
    for (let i = 0; i < 5; i++) {
      await svc.reenviarConfirmacao('u1')
      envelhecer(10 * MINUTO)
    }
    const erro = await svc.reenviarConfirmacao('u1').catch((e: unknown) => e)
    expect(status(erro)).toBe(429)
    expect(String((erro as Error).message)).toMatch(/amanhã/)
    expect(avisos('confirmar-email')).toHaveLength(5)
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
