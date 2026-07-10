import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { canUseNativeAgenda } from '../plans'

// Status que "seguram" o horário (indisponível para outra pessoa marcar).
const BLOCKING = ['pending', 'confirmed'] as const

export interface CreateBookingDto {
  clientName?: string
  clientWhats?: string
  note?: string
  startAt?: string
}

@Injectable()
export class BookingsService {
  constructor(private readonly prisma: PrismaService) {}

  private parseWeekdays(raw: unknown): number[] {
    try {
      const parsed = JSON.parse(typeof raw === 'string' ? raw : '[1,2,3,4,5]')
      if (Array.isArray(parsed)) {
        return parsed.filter((n): n is number => Number.isInteger(n) && n >= 0 && n <= 6)
      }
    } catch {
      /* ignora */
    }
    return [1, 2, 3, 4, 5]
  }

  private config(p: any) {
    return {
      weekdays: this.parseWeekdays(p.bookingWeekdays),
      startMin: p.bookingStartMin ?? 540,
      endMin: p.bookingEndMin ?? 1080,
      slotMin: p.bookingSlotMin ?? 30,
      leadHours: p.bookingLeadHours ?? 12,
      horizonDays: p.bookingHorizonDays ?? 30,
    }
  }

  /** Disponibilidade pública: config + horários já ocupados (futuros). */
  async availability(slug: string) {
    const profile = await this.prisma.profile.findFirst({
      where: { slug, published: true, moderationStatus: { not: 'restricted' } },
      select: {
        id: true,
        plan: true,
        schedulingMode: true,
        bookingWeekdays: true,
        bookingStartMin: true,
        bookingEndMin: true,
        bookingSlotMin: true,
        bookingLeadHours: true,
        bookingHorizonDays: true,
      },
    })
    if (!profile) throw new NotFoundException('Perfil não encontrado')
    const isNative = profile.schedulingMode === 'native' && canUseNativeAgenda(profile.plan)
    if (!isNative) {
      return { mode: profile.schedulingMode ?? 'external', config: this.config(profile), busy: [] as string[] }
    }
    const now = new Date()
    const busyRows = await this.prisma.booking.findMany({
      where: { profileId: profile.id, status: { in: [...BLOCKING] as any }, startAt: { gte: now } },
      select: { startAt: true },
    })
    return {
      mode: 'native' as const,
      config: this.config(profile),
      busy: busyRows.map((b) => b.startAt.toISOString()),
    }
  }

  /** Cliente cria uma solicitação (status pending — segura o horário). */
  async create(slug: string, dto: CreateBookingDto) {
    const profile = await this.prisma.profile.findFirst({
      where: { slug, published: true, moderationStatus: { not: 'restricted' } },
      select: {
        id: true,
        plan: true,
        schedulingMode: true,
        bookingSlotMin: true,
        bookingLeadHours: true,
        bookingHorizonDays: true,
      },
    })
    if (!profile) throw new NotFoundException('Perfil não encontrado')
    if (profile.schedulingMode !== 'native' || !canUseNativeAgenda(profile.plan)) {
      throw new BadRequestException('Este perfil não usa a agenda do advoc.me.')
    }

    const clientName = (dto.clientName ?? '').trim()
    const clientWhats = (dto.clientWhats ?? '').replace(/\D/g, '')
    const note = (dto.note ?? '').trim().slice(0, 500)
    if (clientName.length < 2) throw new BadRequestException('Informe seu nome.')
    if (clientWhats.length < 10 || clientWhats.length > 15) {
      throw new BadRequestException('Informe um WhatsApp válido com DDD.')
    }
    const start = new Date(dto.startAt ?? '')
    if (Number.isNaN(start.getTime())) throw new BadRequestException('Horário inválido.')

    // Janela válida: respeita antecedência mínima e o horizonte configurados.
    const now = Date.now()
    const minStart = now + profile.bookingLeadHours * 3600_000
    const maxStart = now + profile.bookingHorizonDays * 86_400_000
    if (start.getTime() < minStart) throw new BadRequestException('Esse horário já passou da antecedência mínima.')
    if (start.getTime() > maxStart) throw new BadRequestException('Esse horário está além do período disponível.')

    const end = new Date(start.getTime() + profile.bookingSlotMin * 60_000)

    // Anti-conflito: ninguém pode segurar o mesmo horário (pending ou confirmed).
    const clash = await this.prisma.booking.findFirst({
      where: { profileId: profile.id, startAt: start, status: { in: [...BLOCKING] as any } },
      select: { id: true },
    })
    if (clash) throw new ConflictException('Esse horário acabou de ser reservado. Escolha outro.')

    const booking = await this.prisma.booking.create({
      data: { profileId: profile.id, clientName, clientWhats, note, startAt: start, endAt: end, status: 'pending' },
    })
    // Analytics de cliques/agendamentos (kind previsto no schema do LinkEvent).
    void this.prisma.linkEvent.create({ data: { profileId: profile.id, kind: 'scheduling' } })
    return this.toApi(booking)
  }

  /** Lista as solicitações do advogado dono (todas, ordenadas por horário). */
  async listMine(userId: string) {
    const profile = await this.prisma.profile.findUnique({ where: { userId }, select: { id: true } })
    if (!profile) return []
    const rows = await this.prisma.booking.findMany({
      where: { profileId: profile.id },
      orderBy: { startAt: 'asc' },
    })
    return rows.map((b) => this.toApi(b))
  }

  /** Decisão do advogado: aceitar ou recusar (ou cancelar uma já confirmada). */
  async decide(userId: string, bookingId: string, decision: 'confirm' | 'decline' | 'cancel') {
    const profile = await this.prisma.profile.findUnique({ where: { userId }, select: { id: true } })
    if (!profile) throw new NotFoundException('Perfil não encontrado')
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, profileId: profile.id },
    })
    if (!booking) throw new NotFoundException('Solicitação não encontrada')

    const status = decision === 'confirm' ? 'confirmed' : decision === 'decline' ? 'declined' : 'cancelled'
    const updated = await this.prisma.booking.update({
      where: { id: booking.id },
      data: { status, decidedAt: new Date() },
    })
    return this.toApi(updated)
  }

  private toApi(b: any) {
    return {
      id: b.id,
      clientName: b.clientName,
      clientWhats: b.clientWhats,
      note: b.note ?? '',
      startAt: b.startAt.toISOString(),
      endAt: b.endAt.toISOString(),
      status: b.status,
      createdAt: b.createdAt.toISOString(),
    }
  }
}
