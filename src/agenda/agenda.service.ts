import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { planoVigente } from '../assinatura'
import { perfilVisivelAoPublico } from '../profiles/visibilidade'
import { bloqueiosDaAgenda } from './blocks'
import { safeEmail, safePhone } from '../security/sanitize'

const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/
const clean = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : ''

function horario(value: unknown): string {
  if (typeof value !== 'string' || !LOCAL_DATE_TIME.test(value) ||
      Number.isNaN(Date.parse(`${value}:00Z`)) ||
      new Date(`${value}:00Z`).toISOString().slice(0, 16) !== value) {
    throw new BadRequestException('Informe uma data e hora válidas.')
  }
  return value
}

function duracao(value: unknown): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 15 || n > 240) throw new BadRequestException('A duração deve ficar entre 15 e 240 minutos.')
  return n
}

function normalizarEntrada(body: any) {
  const title = clean(body?.title, 100)
  if (title.length < 2) throw new BadRequestException('Informe o nome do compromisso.')
  const startsAt = horario(body?.startsAt)
  const durationMin = duracao(body?.durationMin)
  const start = Number(startsAt.slice(11, 13)) * 60 + Number(startsAt.slice(14, 16))
  if (start + durationMin > 1440) throw new BadRequestException('O compromisso deve terminar no mesmo dia.')
  return { title, startsAt, durationMin }
}

function bate(a: { startsAt: string; durationMin: number }, b: { startsAt: string; durationMin: number }) {
  const inicio = (s: string) => Number(s.slice(11, 13)) * 60 + Number(s.slice(14, 16))
  if (a.startsAt.slice(0, 10) !== b.startsAt.slice(0, 10)) return false
  const x = inicio(a.startsAt), y = inicio(b.startsAt)
  return x < y + b.durationMin && y < x + a.durationMin
}

@Injectable()
export class AgendaService {
  constructor(private readonly prisma: PrismaService) {}

  private async dono(userId: string) {
    const p = await this.prisma.profile.findUnique({ where: { userId } })
    if (!p) throw new NotFoundException('Perfil não encontrado.')
    return p
  }

  private exigirMax(p: Awaited<ReturnType<AgendaService['dono']>>) {
    if (planoVigente(p) !== 'premium') throw new ForbiddenException('A agenda digital está disponível no plano Max.')
  }

  async entradas(userId: string, from?: string, to?: string) {
    const p = await this.dono(userId)
    const inicio = typeof from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : new Date().toISOString().slice(0, 10)
    const fim = typeof to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : '9999-12-31'
    if (fim < inicio) throw new BadRequestException('Período inválido.')
    return this.prisma.calendarEntry.findMany({ where: { profileId: p.id, startsAt: { gte: inicio, lte: `${fim}T23:59` } }, orderBy: { startsAt: 'asc' }, take: 200 })
  }

  private async sincronizar(p: Awaited<ReturnType<AgendaService['dono']>>, db: Prisma.TransactionClient = this.prisma) {
    const entries = await db.calendarEntry.findMany({ where: { profileId: p.id, startsAt: { gte: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10) } }, orderBy: { startsAt: 'asc' }, take: 500 })
    await db.profile.update({ where: { id: p.id }, data: { calendarBusy: JSON.stringify(bloqueiosDaAgenda(entries, p.assistantDays, p.assistantDurationMin)) } })
  }

  async criarEntrada(userId: string, body: any) {
    const p = await this.dono(userId)
    this.exigirMax(p)
    const input = normalizarEntrada(body)
    const others = await this.prisma.calendarEntry.findMany({ where: { profileId: p.id, startsAt: { startsWith: input.startsAt.slice(0, 10) } } })
    if (others.some((entry) => bate(entry, input))) throw new BadRequestException('Já existe um compromisso nesse horário.')
    let entry
    try { entry = await this.prisma.calendarEntry.create({ data: { ...input, profileId: p.id } }) }
    catch (e) {
      if ((e as { code?: string })?.code === 'P2002') throw new ConflictException('Já existe um compromisso nesse horário.')
      throw e
    }
    await this.sincronizar(p)
    return entry
  }

  async editarEntrada(userId: string, id: string, body: any) {
    const p = await this.dono(userId)
    this.exigirMax(p)
    const current = await this.prisma.calendarEntry.findFirst({ where: { id, profileId: p.id } })
    if (!current) throw new NotFoundException('Compromisso não encontrado.')
    const input = normalizarEntrada(body)
    const others = await this.prisma.calendarEntry.findMany({ where: { profileId: p.id, id: { not: id }, startsAt: { startsWith: input.startsAt.slice(0, 10) } } })
    if (others.some((entry) => bate(entry, input))) throw new BadRequestException('Já existe um compromisso nesse horário.')
    let entry
    try { entry = await this.prisma.calendarEntry.update({ where: { id }, data: input }) }
    catch (e) {
      if ((e as { code?: string })?.code === 'P2002') throw new ConflictException('Já existe um compromisso nesse horário.')
      throw e
    }
    await this.sincronizar(p)
    return entry
  }

  async apagarEntrada(userId: string, id: string) {
    const p = await this.dono(userId)
    this.exigirMax(p)
    const current = await this.prisma.calendarEntry.findFirst({ where: { id, profileId: p.id } })
    if (!current) throw new NotFoundException('Compromisso não encontrado.')
    await this.prisma.calendarEntry.delete({ where: { id } })
    await this.sincronizar(p)
    return { ok: true }
  }

  async solicitar(slug: string, body: any) {
    const p = await this.prisma.profile.findFirst({ where: { slug, ...perfilVisivelAoPublico() } })
    if (!p || planoVigente(p) !== 'premium' || !p.meetingInboxEnabled || !['assistant', 'whatsapp'].includes(p.schedulingMode)) {
      throw new NotFoundException('Este perfil não recebe solicitações pelo site.')
    }
    if (body?.consent !== true) throw new BadRequestException('Confirme que seus dados serão enviados ao advogado.')
    const name = clean(body?.name, 70)
    const subject = clean(body?.subject, 220)
    const phone = safePhone(body?.whatsapp, 30)
    const digits = phone?.replace(/\D/g, '') ?? ''
    const whatsapp = digits.length >= 10 && digits.length <= 15 ? phone : null
    const email = safeEmail(body?.email)
    if (name.length < 2 || subject.length < 2 || (!whatsapp && !email)) {
      throw new BadRequestException('Informe nome, assunto e WhatsApp ou e-mail válido.')
    }
    const preferredAt = body?.preferredAt ? horario(body.preferredAt) : null
    let configured: { id: string; label: string }[] = []
    try {
      const parsed = JSON.parse(p.triageQuestions)
      if (p.triageEnabled && Array.isArray(parsed)) configured = parsed
    } catch { /* sem triagem válida */ }
    const labels = new Map(configured.map((q) => [q.id, q.label]))
    const seen = new Set<string>()
    const triage = (Array.isArray(body?.triage) ? body.triage : []).slice(0, 8).flatMap((row: any) => {
      const id = clean(row?.id, 40)
      const pergunta = labels.get(id)
      const resposta = clean(row?.resposta, 500)
      if (!pergunta || !resposta || seen.has(id)) return []
      seen.add(id)
      return [{ id, pergunta: clean(pergunta, 140), resposta }]
    })
    await this.prisma.meetingRequest.create({ data: { profileId: p.id, name, subject, whatsapp, email, preferredAt, triage: JSON.stringify(triage) } })
    return { ok: true }
  }

  async solicitacoes(userId: string, page = 1) {
    const p = await this.dono(userId)
    const pageSize = 10
    const requestedPage = Number.isSafeInteger(page) ? Math.max(1, page) : 1
    const where = { profileId: p.id }
    const [total, pendingCount] = await Promise.all([
      this.prisma.meetingRequest.count({ where }),
      this.prisma.meetingRequest.count({ where: { ...where, status: 'pending' } }),
    ])
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const currentPage = Math.min(requestedPage, totalPages)
    const rows = await this.prisma.meetingRequest.findMany({ where, include: { calendarEntry: { select: { id: true, startsAt: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: pageSize, skip: (currentPage - 1) * pageSize })
    return { items: rows.map((r) => ({ ...r, triage: JSON.parse(r.triage || '[]') })), page: currentPage, pageSize, total, totalPages, pendingCount }
  }

  async decidir(userId: string, id: string, body: { status: string; startsAt?: string; durationMin?: number }) {
    const status = body?.status
    if (!['confirmed', 'declined'].includes(status)) throw new BadRequestException('Escolha confirmar ou negar.')
    const p = await this.dono(userId)
    const request = await this.prisma.meetingRequest.findFirst({ where: { id, profileId: p.id } })
    if (!request) throw new NotFoundException('Solicitação não encontrada.')
    if (status === 'declined') {
      if (request.status !== 'pending') throw new ConflictException('Esta solicitação já foi respondida.')
      const result = await this.prisma.meetingRequest.updateMany({ where: { id, profileId: p.id, status: 'pending' }, data: { status } })
      if (!result.count) throw new ConflictException('Esta solicitação já foi respondida.')
      return { status: 'declined', entry: null }
    }

    this.exigirMax(p)
    if (request.status === 'confirmed' && request.calendarEntryId) {
      const entry = await this.prisma.calendarEntry.findFirst({ where: { id: request.calendarEntryId, profileId: p.id } })
      if (entry) return { status: 'confirmed', entry }
    }
    if (request.status !== 'pending' && request.status !== 'confirmed') throw new ConflictException('Esta solicitação já foi respondida.')
    const input = normalizarEntrada({ title: `Reunião com ${request.name}`, startsAt: body.startsAt, durationMin: body.durationMin ?? p.assistantDurationMin })
    try {
      return await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.meetingRequest.updateMany({ where: { id, profileId: p.id, status: request.status, calendarEntryId: null }, data: { status: 'confirmed' } })
        if (!claimed.count) throw new ConflictException('Esta solicitação já foi respondida.')
        const others = await tx.calendarEntry.findMany({ where: { profileId: p.id, startsAt: { startsWith: input.startsAt.slice(0, 10) } } })
        if (others.some((entry) => bate(entry, input))) throw new ConflictException('Já existe um compromisso nesse horário.')
        const entry = await tx.calendarEntry.create({ data: { ...input, profileId: p.id } })
        await tx.meetingRequest.update({ where: { id }, data: { calendarEntryId: entry.id } })
        await this.sincronizar(p, tx)
        return { status: 'confirmed', entry }
      }, { isolationLevel: 'Serializable' })
    } catch (e) {
      if (['P2002', 'P2034'].includes((e as { code?: string })?.code ?? '')) throw new ConflictException('Já existe um compromisso nesse horário. Escolha outra hora.')
      throw e
    }
  }

  async apagarSolicitacao(userId: string, id: string) {
    const p = await this.dono(userId)
    const request = await this.prisma.meetingRequest.findFirst({ where: { id, profileId: p.id } })
    if (!request) throw new NotFoundException('Solicitação não encontrada.')
    await this.prisma.meetingRequest.delete({ where: { id } })
    return { ok: true }
  }
}
