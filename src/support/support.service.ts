import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { faixa, pagina } from '../admin/paginacao'

// Suporte ao cliente — canal EXCLUSIVO de quem tem conta.
//
// Não confundir com Report (denúncia): aquele é público e trata do conteúdo de
// um terceiro; este é o próprio advogado falando com a plataforma sobre um
// problema dela — bug, dúvida, conta, sugestão.
//
// O corte do texto é generoso mas existe: um relato de bug bom é longo, e um
// campo sem limite é convite a abuso de armazenamento.

// Os tipos vêm daqui, e NÃO de `@prisma/client`.
//
// O motivo é o schema de desenvolvimento: o SQLite não tem enum, então
// gen-dev-schema.mjs os converte em texto — e o cliente gerado localmente deixa
// de exportar `SupportKind`/`SupportStatus`. Importar de lá quebrava o build no
// ambiente local (e SÓ nele), que é justamente onde se testa. Os valores já
// estavam escritos abaixo; agora eles são a fonte do tipo.
const KINDS = ['bug', 'duvida', 'conta', 'sugestao', 'outro'] as const
const STATUSES = ['open', 'in_progress', 'resolved'] as const

type SupportKind = (typeof KINDS)[number]
type SupportStatus = (typeof STATUSES)[number]

const SUBJECT_MAX = 120
const MESSAGE_MAX = 4000
const URL_MAX = 300
const UA_MAX = 300
const NOTE_MAX = 2000

@Injectable()
export class SupportService {
  constructor(private readonly prisma: PrismaService) {}

  /** Advogado abre um chamado. */
  async create(
    userId: string,
    input: { kind?: string; subject?: string; message?: string; pageUrl?: string; userAgent?: string },
  ) {
    const subject = (input.subject ?? '').trim()
    const message = (input.message ?? '').trim()
    if (subject.length < 3) throw new BadRequestException('Escreva um assunto.')
    if (message.length < 10) {
      throw new BadRequestException('Descreva o que aconteceu com um pouco mais de detalhe.')
    }
    const kind = (KINDS as readonly string[]).includes(input.kind ?? '')
      ? (input.kind as SupportKind)
      : 'outro'

    const ticket = await this.prisma.supportTicket.create({
      data: {
        userId,
        kind,
        subject: subject.slice(0, SUBJECT_MAX),
        message: message.slice(0, MESSAGE_MAX),
        pageUrl: (input.pageUrl ?? '').slice(0, URL_MAX),
        userAgent: (input.userAgent ?? '').slice(0, UA_MAX),
      },
      select: { id: true, kind: true, subject: true, status: true, createdAt: true },
    })
    return ticket
  }

  /** Histórico do próprio advogado — inclui a resposta do admin. */
  listMine(userId: string) {
    return this.prisma.supportTicket.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        kind: true,
        subject: true,
        message: true,
        status: true,
        adminNote: true,
        createdAt: true,
        handledAt: true,
      },
    })
  }

  /**
   * Fila do admin. Traz o e-mail e o perfil do autor: sem saber DE QUEM é o
   * chamado, o admin não consegue reproduzir nem responder.
   */
  async listAll(status?: string, limite?: unknown, offset?: unknown) {
    const filtro = (STATUSES as readonly string[]).includes(status ?? '')
      ? { status: status as SupportStatus }
      : {}
    const { take, skip } = faixa(limite, offset)
    const [itens, total] = await this.prisma.$transaction([
      this.prisma.supportTicket.findMany({
        where: filtro,
        // Abertos primeiro, e dentro de cada grupo os mais antigos na frente —
        // fila de atendimento, não mural de novidades. O id desempata para a
        // paginação não embaralhar chamados abertos no mesmo segundo.
        orderBy: [{ status: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take,
        skip,
        include: {
          user: {
            select: {
              email: true,
              profile: { select: { name: true, slug: true, plan: true, oabNumber: true } },
            },
          },
        },
      }),
      this.prisma.supportTicket.count({ where: filtro }),
    ])
    return pagina(itens, total, take, skip)
  }

  /** Admin muda o estado e/ou deixa uma resposta ao autor. */
  /** Situação atual do chamado, para o "antes" do histórico do painel. */
  async situacao(id: string) {
    return this.prisma.supportTicket.findUnique({
      where: { id },
      select: { status: true, handledAt: true },
    })
  }

  async setStatus(id: string, status?: string, note?: string) {
    if (!(STATUSES as readonly string[]).includes(status ?? '')) {
      throw new BadRequestException('Situação inválida.')
    }
    const exists = await this.prisma.supportTicket.findUnique({ where: { id }, select: { id: true } })
    if (!exists) throw new NotFoundException('Chamado não encontrado.')

    const novo = status as SupportStatus
    return this.prisma.supportTicket.update({
      where: { id },
      data: {
        status: novo,
        ...(note === undefined ? {} : { adminNote: note.slice(0, NOTE_MAX) }),
        // handledAt marca a conclusão; reabrir limpa, senão a data mente.
        handledAt: novo === 'resolved' ? new Date() : null,
      },
      select: { id: true, status: true, adminNote: true, handledAt: true },
    })
  }

  /** Contadores para o badge da aba do painel. */
  async counts() {
    const rows = await this.prisma.supportTicket.groupBy({
      by: ['status'],
      _count: { _all: true },
    })
    const out: Record<string, number> = { open: 0, in_progress: 0, resolved: 0 }
    for (const r of rows) out[r.status] = r._count._all
    return out
  }
}
