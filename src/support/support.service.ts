import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { faixa, pagina } from '../admin/paginacao'
import { CorreioService } from '../mail/correio.service'
import { ANEXOS_POR_DIA, TIPOS_DE_ANEXO, lerAnexos, type TipoDeAnexo } from './anexos'

// Suporte ao cliente — canal EXCLUSIVO de quem tem conta.
//
// Não confundir com Report (denúncia): aquele é público e trata do conteúdo de
// um terceiro; este é o próprio advogado falando com a plataforma sobre um
// problema dela — bug, dúvida, conta, sugestão.
//
// O corte do texto é generoso mas existe: um relato de bug bom é longo, e um
// campo sem limite é convite a abuso de armazenamento.
//
// RESPOSTA NOVA (16/09/2026)
//
// A resposta do admin ficava escondida no fim da página de suporte, e nada
// avisava que ela existia — o advogado só a via se voltasse lá por acaso. Agora
// o chamado guarda QUANDO a resposta foi escrita (`answeredAt`) e quando o autor
// a viu (`seenAt`). Resposta mais nova que a última visita é "nova": acende a
// aba Respostas, o menu da conta e o painel, e sai um e-mail.
//
// O e-mail é um por RODADA NÃO LIDA: se o admin corrige um erro de digitação na
// resposta antes de o advogado abrir, não sai um segundo aviso. A chave do aviso
// leva o `seenAt` — depois que a pessoa lê, a próxima resposta avisa de novo.

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
const HISTORICO_MAX = 50
const DIA_MS = 24 * 60 * 60 * 1000

/** Só o que decide se a resposta é nova. */
interface EstadoDaResposta {
  adminNote: string
  answeredAt: Date | null
  seenAt: Date | null
}

/**
 * A resposta deste chamado ainda não foi vista pelo autor?
 *
 * Chamado respondido antes de `answeredAt` existir fica com a data vazia e NÃO
 * conta como novo: acender "resposta nova" em tudo o que já foi lido, no dia do
 * deploy, seria alarme falso na conta de todo mundo.
 */
export function respostaNova(t: EstadoDaResposta): boolean {
  if (!t.adminNote.trim() || !t.answeredAt) return false
  return !t.seenAt || t.seenAt.getTime() < t.answeredAt.getTime()
}

@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    // Opcional só para os testes que não tratam de e-mail. No app o módulo
    // importa o CorreioModule.
    private readonly correio?: CorreioService,
  ) {}

  /** Advogado abre um chamado, com até 3 imagens. */
  async create(
    userId: string,
    input: {
      kind?: string
      subject?: string
      message?: string
      pageUrl?: string
      userAgent?: string
      anexos?: unknown
    },
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
    // Conferidas ANTES de gravar qualquer coisa: imagem recusada não deixa um
    // chamado pela metade para trás.
    const anexos = lerAnexos(input.anexos)

    if (anexos.length) {
      const hoje = await this.prisma.supportAttachment.count({
        where: { ticket: { userId }, createdAt: { gte: new Date(Date.now() - DIA_MS) } },
      })
      if (hoje + anexos.length > ANEXOS_POR_DIA) {
        throw new ForbiddenException(
          'Você já enviou muitas imagens hoje. Descreva o problema por texto ou tente de novo amanhã.',
        )
      }
    }

    const ticket = await this.prisma.supportTicket.create({
      data: {
        userId,
        kind,
        subject: subject.slice(0, SUBJECT_MAX),
        message: message.slice(0, MESSAGE_MAX),
        pageUrl: (input.pageUrl ?? '').slice(0, URL_MAX),
        userAgent: (input.userAgent ?? '').slice(0, UA_MAX),
        ...(anexos.length
          ? {
              anexos: {
                create: anexos.map((a) => ({
                  contentType: a.contentType,
                  data: a.bytes,
                  size: a.bytes.length,
                })),
              },
            }
          : {}),
      },
      select: {
        id: true,
        kind: true,
        subject: true,
        status: true,
        createdAt: true,
        anexos: { select: { id: true, contentType: true, size: true } },
      },
    })
    return ticket
  }

  /** Histórico do próprio advogado — inclui a resposta do admin e as imagens (sem os bytes). */
  async listMine(userId: string) {
    const tickets = await this.prisma.supportTicket.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: HISTORICO_MAX,
      select: {
        id: true,
        kind: true,
        subject: true,
        message: true,
        status: true,
        adminNote: true,
        answeredAt: true,
        seenAt: true,
        createdAt: true,
        handledAt: true,
        anexos: {
          select: { id: true, contentType: true, size: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
      },
    })
    return tickets.map((t) => ({ ...t, novaResposta: respostaNova(t) }))
  }

  /** Quantas respostas o advogado ainda não viu — o ponto no menu e o aviso do painel. */
  async novas(userId: string): Promise<{ novas: number }> {
    const respondidos = await this.prisma.supportTicket.findMany({
      where: { userId, answeredAt: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: HISTORICO_MAX,
      select: { adminNote: true, answeredAt: true, seenAt: true },
    })
    return { novas: respondidos.filter(respostaNova).length }
  }

  /**
   * Marca como vistas as respostas que a tela MOSTROU.
   *
   * Pelos ids, e não "tudo desta conta": se o admin responde no segundo entre a
   * lista carregar e este pedido sair, a resposta que ninguém viu continuaria
   * acesa — e não apagada em silêncio.
   */
  async marcarVistas(userId: string, ids: unknown): Promise<{ vistas: number }> {
    const lista = Array.isArray(ids)
      ? ids.filter((i): i is string => typeof i === 'string' && i.length > 0 && i.length <= 40).slice(0, HISTORICO_MAX)
      : []
    if (!lista.length) return { vistas: 0 }
    const r = await this.prisma.supportTicket.updateMany({
      where: { id: { in: lista }, userId, answeredAt: { not: null } },
      data: { seenAt: new Date() },
    })
    return { vistas: r.count }
  }

  /** Uma imagem de um chamado DO PRÓPRIO autor. De outra conta é "não encontrada", nunca "proibida". */
  async anexoDoAutor(userId: string, ticketId: string, anexoId: string) {
    return this.servirAnexo({ id: anexoId, ticketId, ticket: { userId } })
  }

  /** Uma imagem de qualquer chamado — só o painel chama, depois de `suporte:ler`. */
  async anexoParaPainel(ticketId: string, anexoId: string) {
    return this.servirAnexo({ id: anexoId, ticketId })
  }

  private async servirAnexo(where: {
    id: string
    ticketId: string
    ticket?: { userId: string }
  }): Promise<{ contentType: TipoDeAnexo; bytes: Buffer }> {
    const a = await this.prisma.supportAttachment.findFirst({
      where,
      select: { contentType: true, data: true },
    })
    // O tipo é conferido de novo na saída: é ele que vai no Content-Type, e uma
    // linha gravada fora deste serviço não pode escolher como o navegador a lê.
    if (!a || !(TIPOS_DE_ANEXO as readonly string[]).includes(a.contentType)) {
      throw new NotFoundException('Imagem não encontrada.')
    }
    return { contentType: a.contentType as TipoDeAnexo, bytes: Buffer.from(a.data) }
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
          // Só o que desenha a miniatura. Os bytes saem pela rota da imagem.
          anexos: {
            select: { id: true, contentType: true, size: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          },
        },
      }),
      this.prisma.supportTicket.count({ where: filtro }),
    ])
    return pagina(itens, total, take, skip)
  }

  /** Situação atual do chamado, para o "antes" do histórico do painel. */
  async situacao(id: string) {
    return this.prisma.supportTicket.findUnique({
      where: { id },
      select: { status: true, handledAt: true },
    })
  }

  /** Admin muda o estado e/ou deixa uma resposta ao autor. */
  async setStatus(id: string, status?: string, note?: string) {
    if (!(STATUSES as readonly string[]).includes(status ?? '')) {
      throw new BadRequestException('Situação inválida.')
    }
    const atual = await this.prisma.supportTicket.findUnique({
      where: { id },
      select: {
        id: true,
        adminNote: true,
        seenAt: true,
        createdAt: true,
        userId: true,
        user: { select: { email: true } },
      },
    })
    if (!atual) throw new NotFoundException('Chamado não encontrado.')

    const novo = status as SupportStatus
    const nota = note === undefined ? undefined : note.slice(0, NOTE_MAX)
    // Resposta é TEXTO NOVO. Pôr em análise ou resolver repetindo a mesma nota
    // não é resposta — não acende nada nem manda e-mail.
    const respondeu = nota !== undefined && nota.trim() !== '' && nota.trim() !== atual.adminNote.trim()
    const agora = new Date()

    const resultado = await this.prisma.supportTicket.update({
      where: { id },
      data: {
        status: novo,
        ...(nota === undefined ? {} : { adminNote: nota }),
        ...(respondeu ? { answeredAt: agora } : {}),
        // handledAt marca a conclusão; reabrir limpa, senão a data mente.
        handledAt: novo === 'resolved' ? agora : null,
      },
      select: { id: true, status: true, adminNote: true, answeredAt: true, seenAt: true, handledAt: true },
    })

    if (respondeu && nota) {
      await this.correio?.enfileirar({
        modelo: 'suporte-respondido',
        para: atual.user.email,
        userId: atual.userId,
        dados: { resposta: nota, abertoEm: atual.createdAt, situacao: novo },
        // Um aviso por rodada não lida — ver o topo do arquivo.
        chave: `suporte-respondido:${id}:${atual.seenAt?.getTime() ?? 0}`,
      })
    }
    return resultado
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
