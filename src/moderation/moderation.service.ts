import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { POLICY_VERSION } from '../oab/compliance'
import { isValidAction, isValidReason, type ModerationAction } from './moderation.constants'
import { checkRateLimit, REPORT_RATE_RULES } from './rate-limit'

// Mapeia a ação do admin para o novo estado de moderação do perfil.
const ACTION_TO_STATUS: Record<ModerationAction, 'warned' | 'partial' | 'restricted' | 'active'> = {
  warn: 'warned',
  partial: 'partial',
  restrict: 'restricted',
  clear: 'active',
}

interface CreateReportInput {
  reason: string
  details?: string
  reporterEmail?: string
  /** IP do denunciante (para rate-limit). Não é persistido. */
  ip?: string
}

interface ModerateInput {
  action: string
  note?: string
  hiddenSections?: string[]
  reportIds?: string[]
}

@Injectable()
export class ModerationService {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Denúncia pública ----

  /** Cria uma denúncia sobre o perfil (por slug). Qualquer visitante pode. */
  async createReport(slug: string, input: CreateReportInput) {
    if (!isValidReason(input.reason)) {
      throw new BadRequestException('Motivo de denúncia inválido.')
    }
    const details = (input.details ?? '').trim().slice(0, 2000)
    // Em "outro", exigimos uma descrição — senão a denúncia é inútil ao admin.
    if (input.reason === 'other' && details.length < 5) {
      throw new BadRequestException('Descreva o problema para enviar uma denúncia do tipo "Outro".')
    }
    const email = (input.reporterEmail ?? '').trim().slice(0, 200) || null

    const profile = await this.prisma.profile.findUnique({ where: { slug }, select: { id: true } })
    if (!profile) throw new NotFoundException('Perfil não encontrado')

    // Rate-limit (anti-spam / anti-brigada). Não persistimos o IP — só o usamos aqui.
    const ip = input.ip || 'unknown'
    const tooMany = () =>
      new HttpException(
        'Muitas denúncias em pouco tempo. Aguarde alguns minutos e tente novamente.',
        HttpStatus.TOO_MANY_REQUESTS,
      )
    if (!checkRateLimit(`report:ip:${ip}`, REPORT_RATE_RULES.perIp)) throw tooMany()
    if (!checkRateLimit(`report:ip:${ip}:profile:${profile.id}`, REPORT_RATE_RULES.perIpProfile)) {
      throw tooMany()
    }

    await this.prisma.report.create({
      data: { profileId: profile.id, reason: input.reason, details, reporterEmail: email },
    })
    return { ok: true }
  }

  // ---- Admin: fila e detalhe ----

  /** Fila de denúncias agrupada por perfil (default: só as abertas). */
  async listReports(status: 'open' | 'resolved' | 'dismissed' | 'all' = 'open') {
    const where = status === 'all' ? {} : { status }
    const reports = await this.prisma.report.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        profile: {
          select: {
            id: true,
            slug: true,
            name: true,
            oabNumber: true,
            city: true,
            state: true,
            published: true,
            moderationStatus: true,
          },
        },
      },
    })

    // Agrupa por perfil preservando a ordem (mais recente primeiro).
    const byProfile = new Map<string, { profile: (typeof reports)[number]['profile']; reports: any[] }>()
    for (const r of reports) {
      const key = r.profileId
      if (!byProfile.has(key)) byProfile.set(key, { profile: r.profile, reports: [] })
      const { profile: _omit, ...rest } = r
      byProfile.get(key)!.reports.push(rest)
    }
    return Array.from(byProfile.values()).map((g) => ({
      profile: g.profile,
      reports: g.reports,
      openCount: g.reports.filter((r) => r.status === 'open').length,
      total: g.reports.length,
    }))
  }

  /** Detalhe completo do perfil + todas as suas denúncias (para o admin avaliar). */
  async getProfileForModeration(profileId: string) {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      include: {
        areas: { orderBy: { order: 'asc' } },
        highlights: { orderBy: { order: 'asc' } },
        socials: true,
        reports: { orderBy: { createdAt: 'desc' } },
      },
    })
    if (!profile) throw new NotFoundException('Perfil não encontrado')
    return profile
  }

  // ---- Admin: decisão ----

  /**
   * Aplica a decisão do admin ao perfil e resolve as denúncias relacionadas.
   *  - warn: aviso ao dono, perfil segue no ar
   *  - partial: censura seções (hiddenSections), perfil segue no ar
   *  - restrict: retira o perfil inteiro do ar
   *  - clear: remove qualquer restrição (volta a active)
   */
  async moderateProfile(profileId: string, input: ModerateInput) {
    if (!isValidAction(input.action)) {
      throw new BadRequestException('Ação de moderação inválida.')
    }
    const action = input.action
    const note = (input.note ?? '').trim().slice(0, 1000)

    if (action === 'partial') {
      const sections = (input.hiddenSections ?? []).filter(
        (s) => typeof s === 'string' && s.length > 0,
      )
      if (sections.length === 0) {
        throw new BadRequestException('Selecione ao menos uma seção para censurar.')
      }
    }

    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { id: true, bio: true },
    })
    if (!profile) throw new NotFoundException('Perfil não encontrado')

    const status = ACTION_TO_STATUS[action]
    const hiddenSections =
      action === 'partial' ? JSON.stringify(input.hiddenSections) : '[]'

    await this.prisma.profile.update({
      where: { id: profileId },
      data: {
        moderationStatus: status,
        moderationNote: action === 'clear' ? '' : note,
        hiddenSections,
      },
    })

    // Resolve denúncias: as indicadas, ou todas as abertas do perfil.
    const resolvedStatus = action === 'clear' ? 'dismissed' : 'resolved'
    await this.prisma.report.updateMany({
      where: {
        profileId,
        status: 'open',
        ...(input.reportIds && input.reportIds.length
          ? { id: { in: input.reportIds } }
          : {}),
      },
      data: { status: resolvedStatus, resolution: action, handledAt: new Date() },
    })

    // Trilha de auditoria imutável da decisão de moderação.
    await this.prisma.auditLog.create({
      data: {
        profileId,
        action: `moderation:${action}`,
        complianceStatus: action === 'restrict' ? 'block' : action === 'clear' ? 'ok' : 'warn',
        policyVersion: POLICY_VERSION,
        bioSnapshot: note || profile.bio,
      },
    })

    return this.getProfileForModeration(profileId)
  }

  /** Arquiva uma denúncia isolada (sem penalizar o perfil). */
  async dismissReport(reportId: string) {
    const report = await this.prisma.report.findUnique({ where: { id: reportId }, select: { id: true } })
    if (!report) throw new NotFoundException('Denúncia não encontrada')
    await this.prisma.report.update({
      where: { id: reportId },
      data: { status: 'dismissed', resolution: 'dismiss', handledAt: new Date() },
    })
    return { ok: true }
  }
}
