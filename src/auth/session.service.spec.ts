// A promessa do "sair": o token para de valer no SERVIDOR, não só no navegador.
// Estes testes existem para que ninguém volte a aceitar um token só porque a
// assinatura confere — foi assim que a sessão ficou irrevogável por 7 dias.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UnauthorizedException } from '@nestjs/common'
import { SessionService } from './session.service'
import { issueUserSession } from './user-auth'

type Qualquer = Record<string, any>

/** Prisma dublê com uma tabela de sessões em memória. */
function service() {
  const linhas = new Map<string, { id: string; userId: string; expiresAt: Date }>()
  let seq = 0
  const prisma: Qualquer = {
    session: {
      create: vi.fn(({ data }: Qualquer) => {
        const id = `sess-${++seq}`
        linhas.set(id, { id, userId: data.userId, expiresAt: data.expiresAt })
        return Promise.resolve({ id })
      }),
      findUnique: vi.fn(({ where }: Qualquer) => Promise.resolve(linhas.get(where.id) ?? null)),
      deleteMany: vi.fn(({ where }: Qualquer) => {
        let count = 0
        for (const [id, l] of [...linhas]) {
          const casaId = where.id === undefined || where.id === id
          const casaUser = where.userId === undefined || where.userId === l.userId
          const casaExp = !where.expiresAt?.lt || l.expiresAt < where.expiresAt.lt
          if (casaId && casaUser && casaExp) {
            linhas.delete(id)
            count++
          }
        }
        return Promise.resolve({ count })
      }),
      count: vi.fn(({ where }: Qualquer) =>
        Promise.resolve(
          [...linhas.values()].filter(
            (l) => l.userId === where.userId && l.expiresAt > where.expiresAt.gt,
          ).length,
        ),
      ),
    },
  }
  return { svc: new SessionService(prisma as any), linhas, prisma }
}

const bearer = (t: string) => `Bearer ${t}`

describe('sessão aberta', () => {
  it('o token emitido autentica', async () => {
    const { svc } = service()
    const { token } = await svc.issue('u1')
    expect(await svc.userIdFrom(bearer(token))).toBe('u1')
  })

  it('cada aparelho abre a sua', async () => {
    const { svc, linhas } = service()
    await svc.issue('u1')
    await svc.issue('u1')
    expect(linhas.size).toBe(2)
  })
})

describe('sair', () => {
  it('o token para de valer imediatamente', async () => {
    const { svc } = service()
    const { token } = await svc.issue('u1')
    expect(await svc.userIdFrom(bearer(token))).toBe('u1')

    await svc.revoke(bearer(token))
    // É ESTA linha que não passava antes: a assinatura continua válida, mas a
    // sessão não existe mais.
    expect(await svc.userIdFrom(bearer(token))).toBeNull()
  })

  it('sair num aparelho não derruba o outro', async () => {
    const { svc } = service()
    const celular = await svc.issue('u1')
    const computador = await svc.issue('u1')

    await svc.revoke(bearer(celular.token))
    expect(await svc.userIdFrom(bearer(celular.token))).toBeNull()
    expect(await svc.userIdFrom(bearer(computador.token))).toBe('u1')
  })

  it('encerrar todas derruba tudo de uma vez', async () => {
    const { svc } = service()
    const a = await svc.issue('u1')
    const b = await svc.issue('u1')
    const outro = await svc.issue('u2')

    expect(await svc.revokeAll('u1')).toBe(2)
    expect(await svc.userIdFrom(bearer(a.token))).toBeNull()
    expect(await svc.userIdFrom(bearer(b.token))).toBeNull()
    expect(await svc.userIdFrom(bearer(outro.token))).toBe('u2') // conta alheia intacta
  })

  it('sair com token inválido não explode', async () => {
    const { svc } = service()
    await expect(svc.revoke('Bearer lixo')).resolves.toBeUndefined()
    await expect(svc.revoke(undefined)).resolves.toBeUndefined()
  })
})

describe('falha fechada', () => {
  it('sessão vencida não autentica', async () => {
    const { svc, linhas } = service()
    const { token } = await svc.issue('u1')
    const linha = [...linhas.values()][0]
    linha.expiresAt = new Date(Date.now() - 1)
    expect(await svc.userIdFrom(bearer(token))).toBeNull()
  })

  it('token assinado para uma sessão que não existe não autentica', async () => {
    const { svc } = service()
    const { token } = issueUserSession('u1', 'sessao-inventada', Date.now() + 60_000)
    expect(await svc.userIdFrom(bearer(token))).toBeNull()
  })

  it('token cujo dono não bate com o da linha não autentica', async () => {
    const { svc, linhas } = service()
    await svc.issue('u1')
    const id = [...linhas.keys()][0]
    // Token assinado por nós, com sessão real, mas dizendo ser de outra pessoa.
    const { token } = issueUserSession('u2', id, Date.now() + 60_000)
    expect(await svc.userIdFrom(bearer(token))).toBeNull()
  })

  it('banco fora do ar nega em vez de liberar', async () => {
    const { svc, prisma } = service()
    const { token } = await svc.issue('u1')
    prisma.session.findUnique = vi.fn(() => Promise.reject(new Error('sem banco')))
    expect(await svc.userIdFrom(bearer(token))).toBeNull()
  })

  it('requireUser lança 401 quando não há sessão', async () => {
    const { svc } = service()
    await expect(svc.requireUser('Bearer lixo')).rejects.toThrow(UnauthorizedException)
    await expect(svc.requireUser(undefined)).rejects.toThrow(UnauthorizedException)
  })
})

describe('higiene', () => {
  it('sessões vencidas do usuário saem no login seguinte', async () => {
    const { svc, linhas } = service()
    await svc.issue('u1')
    ;[...linhas.values()][0].expiresAt = new Date(Date.now() - 1)
    await svc.issue('u1')
    expect(linhas.size).toBe(1)
  })
})
