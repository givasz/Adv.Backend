// Modelos próprios. O que não pode regredir:
//
//   • nada que pareça dado pessoal é gravado — nem no título, nem no nome;
//   • criar e editar são do Max, até 3, pelo plano VIGENTE do banco;
//   • excluir vale em qualquer plano, e só o dono enxerga o modelo;
//   • texto além do limite é recusado, nunca cortado em silêncio.

import { describe, expect, it, vi } from 'vitest'
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { ModelosPropriosService } from './modelos-proprios.service'
import { LIMITES_DO_MODELO_PROPRIO } from './modelo-proprio'

type Linha = Record<string, any>
const FUTURO = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

function montar(plano: 'free' | 'pro' | 'premium' = 'premium') {
  const linhas: Linha[] = []
  let seq = 0
  const perfil = { plan: plano, planStatus: 'active', currentPeriodEnd: FUTURO, graceUntil: null }
  const casa = (l: Linha, w: Linha) => Object.entries(w).every(([k, v]) => l[k] === v)
  const prisma = {
    profile: { findUnique: vi.fn(async () => perfil) },
    modeloProprio: {
      findMany: vi.fn(async ({ where }: Linha) => linhas.filter((l) => casa(l, where))),
      findFirst: vi.fn(async ({ where }: Linha) => linhas.find((l) => casa(l, where)) ?? null),
      count: vi.fn(async ({ where }: Linha) => linhas.filter((l) => casa(l, where)).length),
      create: vi.fn(async ({ data }: Linha) => {
        const l = { id: `m${++seq}`, revisao: 1, createdAt: new Date(), updatedAt: new Date(), ...data }
        linhas.push(l)
        return l
      }),
      update: vi.fn(async ({ where, data }: Linha) => {
        const l = linhas.find((x) => x.id === where.id)!
        Object.assign(l, data, { updatedAt: new Date() })
        return l
      }),
      delete: vi.fn(async ({ where }: Linha) => {
        linhas.splice(linhas.findIndex((x) => x.id === where.id), 1)
        return {}
      }),
    },
  }
  return { svc: new ModelosPropriosService(prisma as any), prisma, linhas, perfil }
}

const BOM = {
  nome: 'Consultoria mensal',
  quemAssina: 'ambos',
  titulo: 'Contrato de consultoria jurídica mensal',
  clausulas: [
    { titulo: '', texto: 'De um lado, {Qualificação do cliente}, e de outro, {Sua qualificação}.' },
    { titulo: 'Dos honorários', texto: 'Honorários mensais de {Valor mensal}, nos termos da Lei nº 8.906/1994.' },
  ],
}

describe('criar', () => {
  it('grava o texto com os campos entre chaves e devolve as cláusulas prontas', async () => {
    const { svc, linhas } = montar()
    const m = await svc.criar('u1', BOM)
    expect(m.clausulas).toHaveLength(2)
    expect(m.clausulas[1]!.texto).toContain('{Valor mensal}')
    expect(typeof linhas[0]!.clausulas).toBe('string')
  })

  it.each([
    ['CPF numa cláusula', { clausulas: [{ titulo: '', texto: 'CPF 529.982.247-25' }] }],
    ['e-mail no título', { titulo: 'Contrato de joao@exemplo.com.br' }],
    ['telefone no nome', { nome: 'Cliente (31) 99999-8888' }],
    ['processo no título da cláusula', { clausulas: [{ titulo: 'Autos 0001234-56.2026.8.13.0024', texto: 'x' }] }],
    ['CEP', { clausulas: [{ titulo: '', texto: 'com endereço no CEP 30140-000' }] }],
    ['conta bancária', { clausulas: [{ titulo: '', texto: 'Pix na agência 1234, conta 56789-0' }] }],
  ])('recusa %s, sem gravar nada', async (_nome, troca) => {
    const { svc, linhas } = montar()
    await expect(svc.criar('u1', { ...BOM, ...troca })).rejects.toThrow(/dado pessoal/)
    expect(linhas).toHaveLength(0)
  })

  it('a mensagem diz onde, sem repetir o dado inteiro', async () => {
    const { svc } = montar()
    const erro = await svc
      .criar('u1', { ...BOM, clausulas: [{ titulo: '', texto: 'CPF 529.982.247-25' }] })
      .catch((e: BadRequestException) => e.message)
    expect(erro).toContain('cláusula 1')
    expect(erro).not.toContain('529.982.247-25')
  })

  it('só o Max cria — e o limite é 3', async () => {
    await expect(montar('pro').svc.criar('u1', BOM)).rejects.toThrow(ForbiddenException)
    const { svc } = montar()
    for (let i = 0; i < 3; i++) await svc.criar('u1', BOM)
    await expect(svc.criar('u1', BOM)).rejects.toThrow(/já tem 3/)
  })

  it('texto além do limite é recusado, não cortado', async () => {
    const { svc } = montar()
    const longo = 'a'.repeat(LIMITES_DO_MODELO_PROPRIO.textoDaClausula + 1)
    await expect(svc.criar('u1', { ...BOM, clausulas: [{ titulo: '', texto: longo }] })).rejects.toThrow(
      BadRequestException,
    )
  })

  it.each([
    ['sem nome', { nome: ' ' }],
    ['sem quem assina', { quemAssina: 'todo mundo' }],
    ['sem cláusula com texto', { clausulas: [{ titulo: 'Só título', texto: '' }] }],
    ['campo de um caractere', { clausulas: [{ titulo: '', texto: 'valor {x}' }] }],
  ])('recusa %s', async (_nome, troca) => {
    await expect(montar().svc.criar('u1', { ...BOM, ...troca })).rejects.toThrow(BadRequestException)
  })
})

describe('editar, listar e excluir', () => {
  it('editar sobe a revisão; outra conta não enxerga o modelo', async () => {
    const { svc } = montar()
    const m = await svc.criar('u1', BOM)
    const e = await svc.atualizar('u1', m.id, { ...BOM, nome: 'Consultoria trimestral' })
    expect(e.revisao).toBe(2)
    expect(e.nome).toBe('Consultoria trimestral')
    await expect(svc.atualizar('u2', m.id, BOM)).rejects.toThrow(NotFoundException)
    await expect(svc.excluir('u2', m.id)).rejects.toThrow(NotFoundException)
    expect((await svc.listar('u2')).modelos).toHaveLength(0)
  })

  it('quem desceu de plano não edita, mas lista e exclui o que é seu', async () => {
    const ctx = montar()
    const m = await ctx.svc.criar('u1', BOM)
    ctx.perfil.plan = 'free'
    await expect(ctx.svc.atualizar('u1', m.id, BOM)).rejects.toThrow(ForbiddenException)
    expect((await ctx.svc.listar('u1')).modelos).toHaveLength(1)
    expect(await ctx.svc.excluir('u1', m.id)).toEqual({ excluido: true })
    expect(ctx.linhas).toHaveLength(0)
  })
})
