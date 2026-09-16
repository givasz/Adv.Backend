// Suporte: imagens anexadas e resposta nova. O que não pode regredir:
//
//   • só entra PNG, JPEG ou WebP de verdade — decidido pelos bytes, não pelo rótulo;
//   • imagem recusada não deixa chamado pela metade, e acima do teto é recusa, não corte;
//   • a imagem de um chamado só sai para o autor dele (outra conta: "não encontrada");
//   • resposta nova é TEXTO novo — mudar só a situação não acende nada nem manda e-mail;
//   • um e-mail por rodada não lida, e chamado antigo não vira "novo" no dia do deploy.

import { describe, expect, it, vi } from 'vitest'
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { SupportService, respostaNova } from './support.service'
import { ANEXO_DATA_URI_MAX, ANEXOS_MAX, ANEXOS_POR_DIA, lerAnexos, tipoPelosBytes } from './anexos'

type Linha = Record<string, any>

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(40, 3)])
const uri = (tipo: string, b: Buffer) => `data:${tipo};base64,${b.toString('base64')}`

describe('lerAnexos — o que entra', () => {
  it('aceita PNG, JPEG e WebP verdadeiros, com o tipo decidido pelos bytes', () => {
    const lidos = lerAnexos([uri('image/png', PNG), uri('image/jpeg', JPEG), uri('image/webp', WEBP)])
    expect(lidos.map((a) => a.contentType)).toEqual(['image/png', 'image/jpeg', 'image/webp'])
    expect(lidos[0]!.bytes.equals(PNG)).toBe(true)
  })

  it('ausente é lista vazia', () => {
    expect(lerAnexos(undefined)).toEqual([])
    expect(lerAnexos(null)).toEqual([])
  })

  it.each([
    ['HTML rotulado como PNG', uri('image/png', Buffer.from('<html><script>alert(1)</script></html>'))],
    ['SVG', uri('image/svg+xml', Buffer.from('<svg onload="alert(1)"/>'))],
    ['SVG rotulado como PNG', uri('image/png', Buffer.from('<svg onload="alert(1)"/>'))],
    ['GIF', uri('image/gif', Buffer.from('GIF89a' + 'x'.repeat(20)))],
    ['WebP rotulado como PNG', uri('image/png', WEBP)],
    ['endereço em vez de imagem', 'https://site-do-golpe.test/x.png'],
    ['base64 com lixo', 'data:image/png;base64,iVBOR<script>'],
    ['número', 42],
  ])('recusa %s', (_nome, valor) => {
    expect(() => lerAnexos([valor])).toThrow(BadRequestException)
  })

  it('não é lista: recusa', () => {
    expect(() => lerAnexos(uri('image/png', PNG))).toThrow(BadRequestException)
  })

  it(`mais de ${ANEXOS_MAX} imagens: recusa`, () => {
    expect(() => lerAnexos(Array(ANEXOS_MAX + 1).fill(uri('image/png', PNG)))).toThrow(/até 3 imagens/)
  })

  it('acima do teto é recusada inteira, nunca cortada', () => {
    const grande = uri('image/png', Buffer.concat([PNG, Buffer.alloc(ANEXO_DATA_URI_MAX, 7)]))
    expect(grande.length).toBeGreaterThan(ANEXO_DATA_URI_MAX)
    expect(() => lerAnexos([grande])).toThrow(/grande demais/)
  })

  it('bytes curtos demais para ter assinatura não passam', () => {
    expect(tipoPelosBytes(Buffer.from([0x89, 0x50]))).toBeNull()
    expect(tipoPelosBytes(Buffer.from('RIFF1234WEBP'))).toBeNull()
  })
})

function montar() {
  const tickets: Linha[] = []
  const anexos: Linha[] = []
  let seq = 0
  const casaTicket = (t: Linha, w: Linha = {}) =>
    Object.entries(w).every(([k, v]) => {
      if (k === 'id' && v && typeof v === 'object' && 'in' in v) return (v.in as string[]).includes(t.id)
      if (k === 'answeredAt' && v && typeof v === 'object' && 'not' in v) return t.answeredAt !== null
      return t[k] === v
    })
  const prisma = {
    supportTicket: {
      create: vi.fn(async ({ data }: Linha) => {
        const { anexos: nested, ...campos } = data
        const t = {
          id: `t${++seq}`,
          status: 'open',
          adminNote: '',
          answeredAt: null,
          seenAt: null,
          handledAt: null,
          createdAt: new Date('2026-09-15T13:00:00Z'),
          ...campos,
        }
        tickets.push(t)
        for (const a of nested?.create ?? []) {
          anexos.push({ id: `a${++seq}`, ticketId: t.id, createdAt: new Date(), ...a })
        }
        return { ...t, anexos: anexos.filter((a) => a.ticketId === t.id) }
      }),
      findUnique: vi.fn(async ({ where }: Linha) => {
        const t = tickets.find((x) => x.id === where.id)
        return t ? { ...t, user: { email: `${t.userId}@exemplo.test` } } : null
      }),
      findMany: vi.fn(async ({ where }: Linha) => tickets.filter((t) => casaTicket(t, where)).map((t) => ({ ...t, anexos: [] }))),
      update: vi.fn(async ({ where, data }: Linha) => {
        const t = tickets.find((x) => x.id === where.id)!
        Object.assign(t, data)
        return { ...t }
      }),
      updateMany: vi.fn(async ({ where, data }: Linha) => {
        const alvo = tickets.filter((t) => casaTicket(t, where))
        for (const t of alvo) Object.assign(t, data)
        return { count: alvo.length }
      }),
    },
    supportAttachment: {
      count: vi.fn(async ({ where }: Linha) => {
        const deles = new Set(tickets.filter((t) => t.userId === where.ticket.userId).map((t) => t.id))
        return anexos.filter((a) => deles.has(a.ticketId) && a.createdAt >= where.createdAt.gte).length
      }),
      findFirst: vi.fn(async ({ where }: Linha) => {
        const a = anexos.find((x) => x.id === where.id && x.ticketId === where.ticketId)
        if (!a) return null
        if (where.ticket && tickets.find((t) => t.id === a.ticketId)?.userId !== where.ticket.userId) return null
        return { contentType: a.contentType, data: a.data }
      }),
    },
  }
  const correio = { enfileirar: vi.fn(async () => true) }
  return { svc: new SupportService(prisma as any, correio as any), prisma, tickets, anexos, correio }
}

const CHAMADO = { kind: 'bug', subject: 'Botão não abre', message: 'O botão de agendar não abre no celular.' }

describe('abrir chamado com imagens', () => {
  it('grava os bytes com o tipo e o tamanho, e devolve só os identificadores', async () => {
    const { svc, anexos } = montar()
    const t = await svc.create('u1', { ...CHAMADO, anexos: [uri('image/webp', WEBP), uri('image/png', PNG)] })
    expect(anexos).toHaveLength(2)
    expect(anexos[0]).toMatchObject({ contentType: 'image/webp', size: WEBP.length })
    expect(Buffer.isBuffer(anexos[0]!.data)).toBe(true)
    expect(t.anexos).toHaveLength(2)
  })

  it('imagem recusada não deixa chamado pela metade', async () => {
    const { svc, prisma } = montar()
    await expect(
      svc.create('u1', { ...CHAMADO, anexos: [uri('image/png', Buffer.from('<svg/>'))] }),
    ).rejects.toThrow(BadRequestException)
    expect(prisma.supportTicket.create).not.toHaveBeenCalled()
  })

  it(`segura quem passa de ${ANEXOS_POR_DIA} imagens em 24 horas`, async () => {
    const { svc } = montar()
    for (let i = 0; i < ANEXOS_POR_DIA / 3; i++) {
      await svc.create('u1', { ...CHAMADO, anexos: Array(3).fill(uri('image/jpeg', JPEG)) })
    }
    await expect(svc.create('u1', { ...CHAMADO, anexos: [uri('image/jpeg', JPEG)] })).rejects.toThrow(
      ForbiddenException,
    )
    // Outra conta não é afetada, e chamado só com texto continua saindo.
    await expect(svc.create('u2', { ...CHAMADO, anexos: [uri('image/jpeg', JPEG)] })).resolves.toBeTruthy()
    await expect(svc.create('u1', CHAMADO)).resolves.toBeTruthy()
  })
})

describe('a imagem só sai para quem pode vê-la', () => {
  it('o autor recebe os bytes com o tipo gravado', async () => {
    const { svc, anexos } = montar()
    const t = await svc.create('u1', { ...CHAMADO, anexos: [uri('image/png', PNG)] })
    const img = await svc.anexoDoAutor('u1', t.id, anexos[0]!.id)
    expect(img.contentType).toBe('image/png')
    expect(img.bytes.equals(PNG)).toBe(true)
  })

  it('outra conta recebe "não encontrada", nunca "proibida"', async () => {
    const { svc, anexos } = montar()
    const t = await svc.create('u1', { ...CHAMADO, anexos: [uri('image/png', PNG)] })
    await expect(svc.anexoDoAutor('u2', t.id, anexos[0]!.id)).rejects.toThrow(NotFoundException)
    // Nem trocando o chamado da URL por um da própria conta.
    const meu = await svc.create('u2', CHAMADO)
    await expect(svc.anexoDoAutor('u2', meu.id, anexos[0]!.id)).rejects.toThrow(NotFoundException)
  })

  it('linha gravada com tipo fora da lista não sai com esse tipo', async () => {
    const { svc, anexos } = montar()
    const t = await svc.create('u1', { ...CHAMADO, anexos: [uri('image/png', PNG)] })
    anexos[0]!.contentType = 'text/html'
    await expect(svc.anexoParaPainel(t.id, anexos[0]!.id)).rejects.toThrow(NotFoundException)
  })
})

describe('resposta nova', () => {
  const quando = (s: string) => new Date(`2026-09-16T${s}:00Z`)

  it('chamado respondido antes de existir a data não acende no dia do deploy', () => {
    expect(respostaNova({ adminNote: 'Resolvido.', answeredAt: null, seenAt: null })).toBe(false)
  })

  it('resposta depois da última visita é nova; vista depois, não é mais', () => {
    expect(respostaNova({ adminNote: 'Ok', answeredAt: quando('10:00'), seenAt: null })).toBe(true)
    expect(respostaNova({ adminNote: 'Ok', answeredAt: quando('10:00'), seenAt: quando('09:00') })).toBe(true)
    expect(respostaNova({ adminNote: 'Ok', answeredAt: quando('10:00'), seenAt: quando('11:00') })).toBe(false)
    expect(respostaNova({ adminNote: '  ', answeredAt: quando('10:00'), seenAt: null })).toBe(false)
  })

  it('texto novo marca a hora da resposta e avisa por e-mail; repetir a nota não', async () => {
    const { svc, tickets, correio } = montar()
    const t = await svc.create('u1', CHAMADO)

    await svc.setStatus(t.id, 'in_progress', 'Estamos olhando o botão.')
    expect(tickets[0]!.answeredAt).toBeInstanceOf(Date)
    expect(correio.enfileirar).toHaveBeenCalledTimes(1)
    expect(correio.enfileirar).toHaveBeenCalledWith(
      expect.objectContaining({
        modelo: 'suporte-respondido',
        para: 'u1@exemplo.test',
        userId: 'u1',
        dados: expect.objectContaining({ resposta: 'Estamos olhando o botão.', situacao: 'in_progress' }),
      }),
    )

    const primeira = tickets[0]!.answeredAt
    await svc.setStatus(t.id, 'resolved', 'Estamos olhando o botão.')
    expect(tickets[0]!.answeredAt).toBe(primeira)
    expect(correio.enfileirar).toHaveBeenCalledTimes(1)
  })

  it('um e-mail por rodada não lida: a chave muda só depois que a pessoa vê', async () => {
    const { svc, correio } = montar()
    const t = await svc.create('u1', CHAMADO)
    await svc.setStatus(t.id, 'in_progress', 'Primeira resposta.')
    await svc.setStatus(t.id, 'in_progress', 'Primeira resposta, corrigida.')
    const chaves = (correio.enfileirar.mock.calls as unknown as [Linha][]).map(([a]) => a.chave)
    // Mesma chave = a fila guarda um aviso só.
    expect(chaves[0]).toBe(chaves[1])

    await svc.marcarVistas('u1', [t.id])
    await svc.setStatus(t.id, 'resolved', 'Resolvido de vez.')
    const depois = (correio.enfileirar.mock.calls as unknown as [Linha][]).map(([a]) => a.chave)
    expect(depois[2]).not.toBe(chaves[0])
  })

  it('marcar vistas só alcança chamados da própria conta', async () => {
    const { svc, tickets } = montar()
    const meu = await svc.create('u1', CHAMADO)
    const alheio = await svc.create('u2', CHAMADO)
    await svc.setStatus(meu.id, 'resolved', 'Pronto.')
    await svc.setStatus(alheio.id, 'resolved', 'Pronto.')

    expect(await svc.novas('u1')).toEqual({ novas: 1 })
    expect(await svc.marcarVistas('u1', [meu.id, alheio.id, 42, 'x'.repeat(200)])).toEqual({ vistas: 1 })
    expect(await svc.novas('u1')).toEqual({ novas: 0 })
    expect(tickets.find((x) => x.id === alheio.id)!.seenAt).toBeNull()
    expect(await svc.novas('u2')).toEqual({ novas: 1 })
    expect(await svc.marcarVistas('u2', 'tudo')).toEqual({ vistas: 0 })
  })
})
