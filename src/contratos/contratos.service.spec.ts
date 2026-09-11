// Registro de documentos. O que não pode regredir:
//
//   • a declaração de revisão só vale com `=== true`, conferida AQUI;
//   • registrar minuta nova é do Max — pelo plano VIGENTE do banco, nunca do corpo;
//   • a versão assinada de um documento já registrado não depende de plano
//     (prova que some quando a assinatura vence não é prova);
//   • a conferência pública nunca devolve IP, navegador nem conta.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { ContratosService } from './contratos.service'
import { DECLARACAO_DE_REVISAO_VERSAO, MODELOS_DE_DOCUMENTO } from './modelos'

type Linha = Record<string, any>

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const FUTURO = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

function perfil(plano: 'free' | 'pro' | 'premium', extra: Linha = {}) {
  return {
    name: 'Marina Sales',
    oabNumber: 'OAB/MG 123.456',
    plan: plano,
    planStatus: 'active',
    currentPeriodEnd: FUTURO,
    graceUntil: null,
    ...extra,
  }
}

function casa(linha: Linha, where: Linha): boolean {
  return Object.entries(where).every(([k, v]) =>
    v && typeof v === 'object' && 'in' in v ? (v.in as unknown[]).includes(linha[k]) : linha[k] === v,
  )
}

function montar(opts: { perfil?: Linha | null } = {}) {
  const linhas: Linha[] = []
  let seq = 0
  const prisma = {
    profile: {
      findUnique: vi.fn(async () => (opts.perfil === undefined ? perfil('premium') : opts.perfil)),
    },
    registroDocumento: {
      findFirst: vi.fn(async ({ where }: Linha) => linhas.find((l) => casa(l, where)) ?? null),
      findMany: vi.fn(async ({ where }: Linha) => linhas.filter((l) => casa(l, where))),
      count: vi.fn(async ({ where }: Linha) => linhas.filter((l) => casa(l, where)).length),
      create: vi.fn(async ({ data }: Linha) => {
        const nova = {
          id: `r${++seq}`,
          origemId: null,
          declaracaoVersao: '',
          createdAt: new Date('2026-09-10T15:00:00Z'),
          ...data,
        }
        linhas.push(nova)
        return nova
      }),
    },
  }
  return { svc: new ContratosService(prisma as any), prisma, linhas }
}

const ORIGEM = { ip: '198.51.100.7', userAgent: 'Mozilla/5.0 (iPhone)' }

function revisado(extra: Linha = {}) {
  return {
    etapa: 'revisado',
    modelo: 'procuracao',
    modeloVersao: MODELOS_DE_DOCUMENTO.procuracao,
    declaracaoVersao: DECLARACAO_DE_REVISAO_VERSAO,
    codigo: 'AVM-7K2P-9QXD',
    hash: HASH_A,
    tamanho: 4096,
    declaracoes: { revisei: true, responsabilidade: true },
    ...extra,
  }
}

describe('registrar a minuta revisada', () => {
  let ctx: ReturnType<typeof montar>
  beforeEach(() => {
    ctx = montar()
  })

  it('grava a impressão digital, a declaração, o IP e a fotografia do perfil', async () => {
    const r = await ctx.svc.registrar('u1', revisado(), ORIGEM)
    expect(r.codigo).toBe('AVM-7K2P-9QXD')
    expect(r.etapa).toBe('revisado')
    const gravada = ctx.linhas[0]
    expect(gravada.ip).toBe('198.51.100.7')
    expect(gravada.declaracaoVersao).toBe(DECLARACAO_DE_REVISAO_VERSAO)
    // O nome vem do BANCO, não do corpo.
    expect(gravada.advogadoNome).toBe('Marina Sales')
    expect(gravada.advogadoOab).toBe('OAB/MG 123.456')
  })

  it.each([
    ['texto "true"', { revisei: 'true', responsabilidade: true }],
    ['número 1', { revisei: true, responsabilidade: 1 }],
    ['faltando uma', { revisei: true }],
    ['nenhuma', undefined],
  ])('declaração que não é true de verdade é recusada (%s)', async (_nome, declaracoes) => {
    await expect(ctx.svc.registrar('u1', revisado({ declaracoes }), ORIGEM)).rejects.toThrow(
      BadRequestException,
    )
    expect(ctx.linhas).toHaveLength(0)
  })

  it('só o Max registra — e o plano é o vigente do banco', async () => {
    const pro = montar({ perfil: perfil('pro') })
    await expect(pro.svc.registrar('u1', revisado({ plan: 'premium' }), ORIGEM)).rejects.toThrow(
      ForbiddenException,
    )
    // Max contratado, mas vencido há muito: não vale mais.
    const vencido = montar({
      perfil: perfil('premium', { currentPeriodEnd: new Date('2026-01-01'), planStatus: 'canceled' }),
    })
    await expect(vencido.svc.registrar('u1', revisado(), ORIGEM)).rejects.toThrow(ForbiddenException)
    const semPerfil = montar({ perfil: null })
    await expect(semPerfil.svc.registrar('u1', revisado(), ORIGEM)).rejects.toThrow(ForbiddenException)
  })

  it('sem nome ou inscrição no perfil não há registro', async () => {
    const semOab = montar({ perfil: perfil('premium', { oabNumber: '  ' }) })
    await expect(semOab.svc.registrar('u1', revisado(), ORIGEM)).rejects.toThrow(BadRequestException)
  })

  it.each([
    ['hash curto', { hash: 'abc' }],
    ['hash com letra fora do hexadecimal', { hash: 'g'.repeat(64) }],
    ['tamanho zero', { tamanho: 0 }],
    ['tamanho quebrado', { tamanho: 10.5 }],
    ['código fora do formato', { codigo: 'AVM-IIII-OOOO' }],
    ['modelo desconhecido', { modelo: 'peticao' }],
    ['revisão antiga do modelo', { modeloVersao: '2020-01-01' }],
    ['revisão antiga da declaração', { declaracaoVersao: '2020-01-01' }],
    ['etapa inventada', { etapa: 'aprovado' }],
  ])('recusa %s', async (_nome, extra) => {
    await expect(ctx.svc.registrar('u1', revisado(extra), ORIGEM)).rejects.toThrow(BadRequestException)
  })

  it('o mesmo arquivo de novo devolve o registro que já existe', async () => {
    const a = await ctx.svc.registrar('u1', revisado(), ORIGEM)
    const b = await ctx.svc.registrar('u1', revisado(), ORIGEM)
    expect(b.id).toBe(a.id)
    expect(ctx.linhas).toHaveLength(1)
  })

  it('código já usado por outro documento é 409 — o aparelho sorteia outro', async () => {
    await ctx.svc.registrar('u1', revisado(), ORIGEM)
    await expect(ctx.svc.registrar('u2', revisado({ hash: HASH_B }), ORIGEM)).rejects.toThrow(
      ConflictException,
    )
  })
})

describe('registrar a versão assinada', () => {
  it('pendura no documento de origem, com o código e a fotografia dele', async () => {
    const ctx = montar()
    await ctx.svc.registrar('u1', revisado(), ORIGEM)
    const r = await ctx.svc.registrar(
      'u1',
      { etapa: 'assinado', origemCodigo: 'AVM-7K2P-9QXD', hash: HASH_B, tamanho: 9000 },
      ORIGEM,
    )
    expect(r.etapa).toBe('assinado')
    expect(r.codigo).toBe('AVM-7K2P-9QXD')
    expect(r.origemId).toBe('r1')
    expect(r.modelo).toBe('procuracao')
    expect(r.advogado.nome).toBe('Marina Sales')
  })

  it('não depende de plano: quem voltou ao Free ainda registra a assinatura do que já registrou', async () => {
    const ctx = montar()
    await ctx.svc.registrar('u1', revisado(), ORIGEM)
    ctx.prisma.profile.findUnique.mockResolvedValue(perfil('free') as any)
    const r = await ctx.svc.registrar(
      'u1',
      { etapa: 'assinado', origemCodigo: 'AVM-7K2P-9QXD', hash: HASH_B, tamanho: 9000 },
      ORIGEM,
    )
    expect(r.etapa).toBe('assinado')
  })

  it('documento de outra conta não serve de origem', async () => {
    const ctx = montar()
    await ctx.svc.registrar('u1', revisado(), ORIGEM)
    await expect(
      ctx.svc.registrar(
        'u2',
        { etapa: 'assinado', origemCodigo: 'AVM-7K2P-9QXD', hash: HASH_B, tamanho: 9000 },
        ORIGEM,
      ),
    ).rejects.toThrow(NotFoundException)
  })

  it('o mesmo arquivo da revisão não é "versão assinada"', async () => {
    const ctx = montar()
    await ctx.svc.registrar('u1', revisado(), ORIGEM)
    await expect(
      ctx.svc.registrar(
        'u1',
        { etapa: 'assinado', origemCodigo: 'AVM-7K2P-9QXD', hash: HASH_A, tamanho: 4096 },
        ORIGEM,
      ),
    ).rejects.toThrow(BadRequestException)
  })
})

describe('conferência pública', () => {
  it('devolve só o que o PDF já traz — nada de IP, navegador ou conta', async () => {
    const ctx = montar()
    await ctx.svc.registrar('u1', revisado(), ORIGEM)
    const { registros } = await ctx.svc.conferir([HASH_A.toUpperCase(), 'lixo', HASH_B])
    expect(registros).toHaveLength(1)
    const texto = JSON.stringify(registros)
    expect(texto).not.toContain('198.51.100.7')
    expect(texto).not.toContain('iPhone')
    expect(texto).not.toContain('u1')
    expect(registros[0]).toMatchObject({ codigo: 'AVM-7K2P-9QXD', etapa: 'revisado', tamanho: 4096 })
    // E a consulta ao banco nem PEDE essas colunas.
    const select = ctx.prisma.registroDocumento.findMany.mock.lastCall![0].select
    expect(select).not.toHaveProperty('ip')
    expect(select).not.toHaveProperty('userAgent')
    expect(select).not.toHaveProperty('userId')
  })

  it('sem nenhuma impressão digital válida é 400, e o lote tem teto', async () => {
    const ctx = montar()
    await expect(ctx.svc.conferir(['', 'xyz'])).rejects.toThrow(BadRequestException)
    await expect(ctx.svc.conferir('não é lista')).rejects.toThrow(BadRequestException)
    const muitos = Array.from({ length: 40 }, (_, i) => i.toString(16).padStart(64, '0'))
    await ctx.svc.conferir(muitos)
    const where = ctx.prisma.registroDocumento.findMany.mock.lastCall![0].where
    expect(where.hash.in).toHaveLength(12)
  })
})
