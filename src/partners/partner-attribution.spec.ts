// O selo da atribuição e o que o banco garante sozinho.
//
// O cookie decide quem ganha dias de Max: escrito à mão, ele daria a qualquer um o
// poder de atribuir a própria conta nova a quem quisesse. E a idempotência do
// programa não mora no código — mora nas chaves únicas do schema. Se uma delas
// sumir numa refatoração, a recompensa dupla volta sem nenhum teste de serviço
// perceber, porque os dublês não sabem o que o banco garante.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  abrirAtribuicao,
  codigoValido,
  novoCodigo,
  parceiroQueAtribui,
  selarAtribuicao,
  VALIDADE_DA_ATRIBUICAO_MS,
} from './partner-attribution'

const AGORA = Date.parse('2026-10-07T12:00:00.000Z')
const ID = 'memb00000001'

describe('o selo da atribuição', () => {
  it('abre o que selou, com a data do NOSSO relógio', () => {
    const r = abrirAtribuicao(selarAtribuicao(ID, AGORA), AGORA + 1000)
    expect(r).toEqual({ partnerId: ID, emitidaEm: new Date(AGORA) })
  })

  it('vence em 30 dias contados da emissão', () => {
    const selo = selarAtribuicao(ID, AGORA)
    expect(abrirAtribuicao(selo, AGORA + VALIDADE_DA_ATRIBUICAO_MS - 1)).not.toBeNull()
    expect(abrirAtribuicao(selo, AGORA + VALIDADE_DA_ATRIBUICAO_MS)).toBeNull()
    expect(VALIDADE_DA_ATRIBUICAO_MS).toBe(30 * 24 * 60 * 60 * 1000)
  })

  it('não aceita selo adulterado, nem data escolhida por quem forja', () => {
    const selo = selarAtribuicao(ID, AGORA)
    const [corpo, assinatura] = selo.split('.')
    const forjado = Buffer.from(JSON.stringify({ v: 1, p: 'memb99999999', iat: AGORA, n: 'x' })).toString('base64url')
    expect(abrirAtribuicao(`${forjado}.${assinatura}`, AGORA)).toBeNull()
    expect(abrirAtribuicao(`${corpo}.${assinatura!.slice(0, -2)}AA`, AGORA)).toBeNull()
    expect(abrirAtribuicao('lixo', AGORA)).toBeNull()
    expect(abrirAtribuicao(undefined, AGORA)).toBeNull()
    // Emitido "no futuro" (relógio forjado): recusado.
    expect(abrirAtribuicao(selarAtribuicao(ID, AGORA + 60 * 60 * 1000), AGORA)).toBeNull()
  })

  it('tem domínio próprio: o mesmo HMAC sem "partner-ref:v1:" não vale', () => {
    const corpo = Buffer.from(JSON.stringify({ v: 1, p: ID, iat: AGORA, n: 'x' })).toString('base64url')
    const semDominio = createHmac('sha256', 'dev-user-secret').update(corpo).digest('base64url')
    const comOutroDominio = createHmac('sha256', 'dev-user-secret').update(`google:v1:${corpo}`).digest('base64url')
    expect(abrirAtribuicao(`${corpo}.${semDominio}`, AGORA)).toBeNull()
    expect(abrirAtribuicao(`${corpo}.${comOutroDominio}`, AGORA)).toBeNull()
  })
})

describe('o código', () => {
  it('é sorteado (16 bytes), sem relação com nada da pessoa, e só esse formato é aceito', () => {
    const a = novoCodigo()
    const b = novoCodigo()
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(a).not.toBe(b)
    expect(codigoValido(a)).toBe(a)
    expect(codigoValido('curto')).toBeNull()
    expect(codigoValido('x'.repeat(65))).toBeNull()
    expect(codigoValido('<script>alert(1)</script>')).toBeNull()
    expect(codigoValido(123)).toBeNull()
  })
})

describe('quem a atribuição alcança na hora do cadastro', () => {
  const prisma = (m: unknown) => ({ partnerMembership: { findUnique: vi.fn(async () => m) } }) as any
  const atribuicao = { partnerId: ID, emitidaEm: new Date(AGORA) }

  it('participação ativa atribui; suspensa, encerrada, convidada ou inexistente, não', async () => {
    expect(await parceiroQueAtribui(prisma({ id: ID, status: 'active', profile: { userId: 'u1' } }), atribuicao)).toBe(ID)
    for (const status of ['suspended', 'ended', 'invited']) {
      expect(await parceiroQueAtribui(prisma({ id: ID, status, profile: { userId: 'u1' } }), atribuicao), status).toBeNull()
    }
    expect(await parceiroQueAtribui(prisma(null), atribuicao)).toBeNull()
    expect(await parceiroQueAtribui(prisma({ id: ID, status: 'active' }), null)).toBeNull()
  })

  it('ninguém indica a si mesmo, e banco instável vira cadastro sem indicação', async () => {
    expect(await parceiroQueAtribui(prisma({ id: ID, status: 'active', profile: { userId: 'u1' } }), atribuicao, 'u1')).toBeNull()
    const quebrado = { partnerMembership: { findUnique: vi.fn(async () => Promise.reject(new Error('fora'))) } } as any
    expect(await parceiroQueAtribui(quebrado, atribuicao)).toBeNull()
  })
})

describe('o que o banco garante (schema.prisma)', () => {
  const schema = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8')
  const modelo = (nome: string) => {
    const m = new RegExp(`model ${nome} \\{([\\s\\S]*?)\\n\\}`).exec(schema)
    expect(m, nome).not.toBeNull()
    return m![1]!
  }
  const unico = (bloco: string, campo: string) => new RegExp(`\\n\\s+${campo}\\s+[^\\n]*@unique`).test(bloco)

  it('as chaves únicas que fazem a idempotência existem', () => {
    const membro = modelo('PartnerMembership')
    expect(unico(membro, 'profileId')).toBe(true)
    expect(unico(membro, 'referralCode')).toBe(true)
    expect(unico(modelo('PartnerReferral'), 'referredUserId')).toBe(true)
    const recompensa = modelo('PartnerReward')
    expect(unico(recompensa, 'key')).toBe(true)
    expect(unico(recompensa, 'referralId')).toBe(true)
    expect(unico(recompensa, 'sourcePaymentId')).toBe(true)
  })

  it('o programa não se liga a dado de cliente nem mexe no Plan ou no Profile financeiro', () => {
    for (const nome of ['PartnerMembership', 'PartnerReferral', 'PartnerReward']) {
      expect(modelo(nome), nome).not.toMatch(/MeetingRequest|LinkEvent|CalendarEntry|Report\b/)
    }
    expect(modelo('Profile')).not.toMatch(/partnerBenefitUntil/)
    expect(/enum Plan \{\s*free\s*pro\s*premium\s*\}/.test(schema)).toBe(true)
  })

  it('a conta indicada pode ser excluída sem levar o histórico do parceiro', () => {
    expect(modelo('PartnerReferral')).toMatch(/referredUser\s+User\?\s+@relation\("ReferredUser",[^\n]*onDelete: SetNull\)/)
  })
})
