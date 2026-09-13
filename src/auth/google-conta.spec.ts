// "Continuar com o Google" — do lado da CONTA. O que não pode regredir:
//
//   • a ligação é pelo `sub`, e o e-mail só serve para achar a conta na 1ª vez;
//   • conta com e-mail confirmado ganha a ligação e mantém a senha;
//   • conta com e-mail NUNCA confirmado perde a senha e as sessões (pré-sequestro);
//   • conta ligada a outra conta Google não é tomada;
//   • sanção vale por esta porta como vale pela senha;
//   • conta nova só nasce com o aceite dos Termos — sem ele, nada é criado;
//   • conta nova nasce sem senha, com e-mail confirmado e sem e-mail de confirmação;
//   • login por senha numa conta sem senha recusa igual a uma conta que não existe.

import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { AuthService } from './auth.service'
import { hashPassword } from './user-auth'
import { TERMS_VERSION } from '../legal/termos'

const req = {} as never
const IDENTIDADE = { sub: 'g-111', email: 'marina@exemplo.com', nome: 'Marina Sales' }
const OPCOES = { lembrar: true, aceitouTermos: false, ip: '203.0.113.9' }
const SENHA = 'Marina#Sales2026'

type Conta = Record<string, any>

function conta(extra: Conta = {}): Conta {
  return {
    id: 'u1',
    email: 'marina@exemplo.com',
    password: 'scrypt$N=32768,r=8,p=3$aa$bb',
    googleSub: null,
    emailVerifiedAt: new Date('2026-09-01'),
    suspendedUntil: null,
    suspendedReason: '',
    closedAt: null,
    closedReason: '',
    termsVersion: TERMS_VERSION,
    profile: { id: 'p1', name: 'Marina', plan: 'free', planStatus: 'active', currentPeriodEnd: null, graceUntil: null },
    ...extra,
  }
}

function montar(contas: Conta[] = []) {
  const users = contas
  const prisma: any = {
    user: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id) return users.find((u) => u.id === where.id) ?? null
        if (where.googleSub) return users.find((u) => u.googleSub === where.googleSub) ?? null
        return users.find((u) => u.email === where.email) ?? null
      }),
      update: vi.fn(async ({ where, data }: any) => Object.assign(users.find((u) => u.id === where.id)!, data)),
      create: vi.fn(async ({ data }: any) => {
        const { profile, ...resto } = data
        const nova = {
          id: `u${users.length + 1}`,
          suspendedUntil: null,
          suspendedReason: '',
          closedAt: null,
          closedReason: '',
          ...resto,
          profile: { id: 'p-nova', ...profile.create },
        }
        users.push(nova)
        return nova
      }),
    },
    firmInvite: { findFirst: vi.fn(async () => null) },
  }
  const sessions: any = {
    abrir: vi.fn(async () => ({ expiresAt: 1, csrfToken: 'c', remember: true })),
    encerrarTodas: vi.fn(async () => 1),
  }
  const correio: any = { ativo: true, enfileirar: vi.fn(async () => true) }
  return { svc: new AuthService(prisma, sessions, correio), users, prisma, sessions, correio }
}

describe('conta que já existe', () => {
  it('já ligada ao Google: entra pelo sub, mesmo com o e-mail diferente, sem mexer em nada', async () => {
    const { svc, prisma } = montar([conta({ googleSub: 'g-111', email: 'antigo@exemplo.com' })])
    const r = await svc.entrarComGoogle(req, IDENTIDADE, OPCOES)
    expect(r.etapa).toBe('sessao')
    if (r.etapa !== 'sessao') return
    expect(r.sessao.user.id).toBe('u1')
    expect(r.sessao.user.google).toBe(true)
    expect(r.sessao.user.temSenha).toBe(true)
    expect(r).toMatchObject({ novaConta: false, vinculou: false, senhaDesligada: false })
    expect(prisma.user.update).not.toHaveBeenCalled()
  })

  it('e-mail confirmado: liga a conta Google e a senha continua valendo', async () => {
    const { svc, users, sessions } = montar([conta()])
    const r = await svc.entrarComGoogle(req, IDENTIDADE, OPCOES)
    expect(r).toMatchObject({ etapa: 'sessao', vinculou: true, senhaDesligada: false })
    expect(users[0]!.googleSub).toBe('g-111')
    expect(users[0]!.password).toBe('scrypt$N=32768,r=8,p=3$aa$bb')
    expect(sessions.encerrarTodas).not.toHaveBeenCalled()
  })

  it('e-mail em maiúsculas vindo do Google acha a mesma conta', async () => {
    const { svc, users } = montar([conta()])
    await svc.entrarComGoogle(req, { ...IDENTIDADE, email: 'MARINA@Exemplo.com' }, OPCOES)
    expect(users).toHaveLength(1)
    expect(users[0]!.googleSub).toBe('g-111')
  })

  it('e-mail NUNCA confirmado: liga, confirma, desliga a senha e derruba as sessões antes de abrir a nova', async () => {
    const { svc, users, sessions } = montar([conta({ emailVerifiedAt: null })])
    const r = await svc.entrarComGoogle(req, IDENTIDADE, OPCOES)
    expect(r).toMatchObject({ etapa: 'sessao', vinculou: true, senhaDesligada: true })
    expect(users[0]!.password).toBe('')
    expect(users[0]!.emailVerifiedAt).toBeInstanceOf(Date)
    expect(sessions.encerrarTodas).toHaveBeenCalledWith('u1')
    expect(sessions.encerrarTodas.mock.invocationCallOrder[0]).toBeLessThan(sessions.abrir.mock.invocationCallOrder[0])
    if (r.etapa === 'sessao') expect(r.sessao.user.temSenha).toBe(false)
  })

  it('ligada a OUTRA conta Google: recusa, e não mexe na conta nem abre sessão', async () => {
    const { svc, prisma, sessions } = montar([conta({ googleSub: 'g-999' })])
    await expect(svc.entrarComGoogle(req, IDENTIDADE, OPCOES)).rejects.toThrow(ConflictException)
    expect(prisma.user.update).not.toHaveBeenCalled()
    expect(sessions.abrir).not.toHaveBeenCalled()
  })

  it('suspensa: não ganha porta nova — recusa antes de ligar', async () => {
    const amanha = new Date(Date.now() + 86_400_000)
    const { svc, prisma } = montar([conta({ suspendedUntil: amanha, suspendedReason: 'perfil falso' })])
    await expect(svc.entrarComGoogle(req, IDENTIDADE, OPCOES)).rejects.toThrow(/suspensa.*perfil falso/)
    expect(prisma.user.update).not.toHaveBeenCalled()
  })

  it('encerrada e já ligada ao Google: não entra', async () => {
    const { svc, sessions } = montar([conta({ googleSub: 'g-111', closedAt: new Date() })])
    await expect(svc.entrarComGoogle(req, IDENTIDADE, OPCOES)).rejects.toThrow(UnauthorizedException)
    expect(sessions.abrir).not.toHaveBeenCalled()
  })
})

describe('conta nova', () => {
  it('sem o aceite dos Termos: pede o aceite e não cria nada', async () => {
    const { svc, prisma, sessions } = montar()
    const r = await svc.entrarComGoogle(req, IDENTIDADE, OPCOES)
    expect(r).toEqual({ etapa: 'aceite', email: 'marina@exemplo.com', nome: 'Marina Sales' })
    expect(prisma.user.create).not.toHaveBeenCalled()
    expect(sessions.abrir).not.toHaveBeenCalled()
  })

  it('com o aceite: nasce sem senha, com e-mail confirmado, aceite registrado e sem e-mail de confirmação', async () => {
    const { svc, users, correio } = montar()
    const r = await svc.entrarComGoogle(req, IDENTIDADE, { ...OPCOES, aceitouTermos: true })
    expect(r).toMatchObject({ etapa: 'sessao', novaConta: true })
    const [nova] = users
    expect(nova).toMatchObject({
      email: 'marina@exemplo.com',
      password: '',
      googleSub: 'g-111',
      termsVersion: TERMS_VERSION,
      termsIp: '203.0.113.9',
    })
    expect(nova!.emailVerifiedAt).toBeInstanceOf(Date)
    expect(nova!.termsAcceptedAt).toBeInstanceOf(Date)
    expect(nova!.profile.name).toBe('Marina Sales')
    expect(nova!.profile.plan).toBe('free')
    expect(correio.enfileirar).not.toHaveBeenCalled()
    if (r.etapa === 'sessao') expect(r.sessao.user).toMatchObject({ temSenha: false, google: true, emailPending: false })
  })

  it('dois toques em "Criar minha conta": o segundo ouve uma frase, não um erro 500', async () => {
    const { svc, prisma } = montar()
    prisma.user.create.mockRejectedValueOnce(Object.assign(new Error('Unique constraint'), { code: 'P2002' }))
    await expect(svc.entrarComGoogle(req, IDENTIDADE, { ...OPCOES, aceitouTermos: true })).rejects.toThrow(ConflictException)
  })

  it('identidade sem e-mail utilizável: recusa', async () => {
    const { svc } = montar()
    await expect(svc.entrarComGoogle(req, { ...IDENTIDADE, email: 'x' }, OPCOES)).rejects.toThrow(BadRequestException)
  })
})

describe('conta sem senha pelas outras portas', () => {
  it('login por senha: a mesma recusa de uma conta que não existe', async () => {
    const { svc, sessions } = montar([conta({ password: '', googleSub: 'g-111' })])
    await expect(svc.login(req, 'marina@exemplo.com', '')).rejects.toThrow('E-mail ou senha incorretos.')
    await expect(svc.login(req, 'marina@exemplo.com', SENHA)).rejects.toThrow('E-mail ou senha incorretos.')
    expect(sessions.abrir).not.toHaveBeenCalled()
  })

  it('trocar a senha: diz o caminho para criar uma, em vez de "a senha atual não confere"', async () => {
    const { svc } = montar([conta({ password: '', googleSub: 'g-111' })])
    await expect(svc.trocarSenha(req, 'u1', '', 'Ceramica-Vento-38-Azul')).rejects.toThrow(/Esqueci minha senha/)
  })

  it('o retrato da sessão diz que não há senha — e o login por senha diz que há', async () => {
    const semSenha = montar([conta({ password: '', googleSub: 'g-111' })])
    expect(await semSenha.svc.me('u1')).toMatchObject({ temSenha: false, google: true })

    const comSenha = montar([conta({ password: await hashPassword(SENHA), googleSub: 'g-111' })])
    const sessao = await comSenha.svc.login(req, 'marina@exemplo.com', SENHA)
    expect(sessao.user).toMatchObject({ temSenha: true, google: true })
  })
})
