import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { complianceStatus, POLICY_VERSION } from '../oab/compliance'
import { limitsFor, NAME_MAX, OAB_MAX, slugify, type LimitedField } from '../plans'

const relations = {
  areas: { orderBy: { order: 'asc' as const } },
  highlights: { orderBy: { order: 'asc' as const } },
  socials: true,
}

@Injectable()
export class ProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  async getBySlug(slug: string) {
    const profile = await this.prisma.profile.findUnique({
      where: { slug, published: true },
      include: relations,
    })
    if (!profile) throw new NotFoundException('Perfil não encontrado')
    // registra a visita de forma assíncrona (não bloqueia a resposta)
    void this.prisma.linkEvent.create({ data: { profileId: profile.id, kind: 'view' } })
    return profile
  }

  getMine(userId: string) {
    return this.prisma.profile.findUnique({ where: { userId }, include: relations })
  }

  // Valida os limites de caracteres do plano (fonte da verdade). Lança 400 se exceder.
  private enforceCharLimits(data: any) {
    // Tetos fixos (não dependem do plano) — sanidade/anti-abuso.
    if (data.name && data.name.length > NAME_MAX) {
      throw new BadRequestException(`O nome excede o limite de ${NAME_MAX} caracteres.`)
    }
    if (data.oabNumber && data.oabNumber.length > OAB_MAX) {
      throw new BadRequestException(`O número da OAB excede o limite de ${OAB_MAX} caracteres.`)
    }

    const lim = limitsFor(data.plan)
    const check = (value: string | undefined, field: LimitedField, label: string) => {
      if (value && value.length > lim[field]) {
        throw new BadRequestException(
          `${label} excede o limite de ${lim[field]} caracteres do plano ${data.plan ?? 'free'}.`,
        )
      }
    }
    check(data.headline, 'headline', 'A frase de apresentação')
    check(data.bio, 'bio', 'A bio')
    for (const a of data.areas ?? []) check(a.description, 'areaDesc', `A descrição da área "${a.label}"`)
    for (const h of data.highlights ?? []) {
      check(h.title, 'highlightTitle', 'O título do destaque')
      check(h.detail, 'highlightDetail', 'O detalhe do destaque')
    }
  }

  // Escada de endereço: Free → sempre com número; Pro/Max → nome limpo (sem número),
  // se disponível. (Max ainda tem o domínio próprio como diferencial exclusivo.)
  // Desempate por número sequencial.
  private async resolveSlug(name: string, plan: string | undefined, selfUserId: string) {
    const base = slugify(name ?? '')
    const takenByOther = async (slug: string) => {
      const p = await this.prisma.profile.findUnique({ where: { slug }, select: { userId: true } })
      return p !== null && p.userId !== selfUserId
    }
    const cleanEligible = plan === 'pro' || plan === 'premium'
    if (cleanEligible && !(await takenByOther(base))) return base
    let n = 2
    // teto de segurança para não iterar infinitamente
    while (n < 10000 && (await takenByOther(`${base}-${n}`))) n++
    return `${base}-${n}`
  }

  async update(userId: string, data: any) {
    // Fonte da verdade dos limites por plano.
    this.enforceCharLimits(data)
    const slug = await this.resolveSlug(data.name, data.plan, userId)

    // Fonte da verdade da conformidade: bloqueia publicação com texto irregular.
    const texts = [data.bio, ...(data.areas ?? []).map((a: any) => a.description)]
    const worstStatus = texts
      .filter((t: string) => t)
      .reduce<'ok' | 'warn' | 'block'>((acc, t: string) => {
        const s = complianceStatus(t)
        if (s === 'block' || acc === 'block') return 'block'
        if (s === 'warn' || acc === 'warn') return 'warn'
        return 'ok'
      }, 'ok')

    if (data.published && worstStatus === 'block') {
      // Registra a tentativa bloqueada na trilha de auditoria antes de recusar.
      const existing = await this.prisma.profile.findUnique({ where: { userId }, select: { id: true } })
      if (existing) {
        // Auditoria deve ser durável antes de recusar — não usar fire-and-forget.
        await this.prisma.auditLog.create({
          data: {
            profileId: existing.id,
            action: 'blocked',
            complianceStatus: 'block',
            policyVersion: POLICY_VERSION,
            bioSnapshot: data.bio ?? '',
          },
        })
      }
      throw new BadRequestException(
        'O texto contém termos que violam as normas de publicidade da OAB. Ajuste antes de publicar.',
      )
    }

    const updated = await this.prisma.profile.update({
      where: { userId },
      data: {
        name: data.name,
        slug, // slug resolvido pelo servidor (regra de nomes iguais + perk do Max)
        oabNumber: data.oabNumber,
        headline: data.headline,
        bio: data.bio,
        avatarUrl: data.avatarUrl,
        city: data.city,
        state: data.state,
        regionNote: data.regionNote,
        inPerson: data.serviceMode?.inPerson,
        online: data.serviceMode?.online,
        whatsapp: data.contact?.whatsapp,
        email: data.contact?.email,
        scheduling: data.contact?.scheduling,
        theme: data.theme,
        published: data.published,
        policyVersion: POLICY_VERSION,
        // substitui coleções filhas (padrão simples; otimizável com upserts)
        areas: {
          deleteMany: {},
          create: (data.areas ?? []).map((a: any, order: number) => ({
            label: a.label,
            description: a.description,
            order,
          })),
        },
        highlights: {
          deleteMany: {},
          create: (data.highlights ?? []).map((h: any, order: number) => ({
            title: h.title,
            detail: h.detail,
            order,
          })),
        },
        socials: {
          deleteMany: {},
          create: (data.socials ?? []).map((s: any) => ({ kind: s.kind, url: s.url })),
        },
      },
      include: relations,
    })

    // Trilha de auditoria: registra a versão salva, o status de conformidade e a
    // política aplicada. Awaited para garantir durabilidade do registro.
    await this.prisma.auditLog.create({
      data: {
        profileId: updated.id,
        action: data.published ? 'publish' : 'update',
        complianceStatus: worstStatus,
        policyVersion: POLICY_VERSION,
        bioSnapshot: data.bio ?? '',
      },
    })

    return updated
  }

  // ---- Conferência de OAB (workflow: none → pending → verified/rejected) ----
  // Ver docs/oab-verificacao-escalonamento.md. Fase 1: revisão manual por admin.

  /** Advogado solicita a conferência do próprio número (não concede a marca). */
  async requestOab(userId: string) {
    const profile = await this.prisma.profile.findUnique({
      where: { userId },
      select: { id: true, oabStatus: true },
    })
    if (!profile) throw new NotFoundException('Perfil não encontrado')
    if (profile.oabStatus === 'verified') return { oabStatus: 'verified' as const }

    const updated = await this.prisma.profile.update({
      where: { userId },
      data: { oabStatus: 'pending' },
      select: { oabStatus: true },
    })
    await this.prisma.auditLog.create({
      data: {
        profileId: profile.id,
        action: 'oab:request',
        complianceStatus: 'ok',
        policyVersion: POLICY_VERSION,
      },
    })
    return { oabStatus: updated.oabStatus }
  }

  /** Fila de conferências pendentes (uso do admin). */
  listPendingOab() {
    return this.prisma.profile.findMany({
      where: { oabStatus: 'pending' },
      orderBy: { updatedAt: 'asc' },
      select: {
        id: true,
        name: true,
        oabNumber: true,
        city: true,
        state: true,
        slug: true,
        updatedAt: true,
      },
    })
  }

  /** Decisão do admin: aprova (marca "OAB conferida") ou rejeita, com auditoria. */
  async decideOab(profileId: string, decision: 'verify' | 'reject', reason?: string) {
    const verified = decision === 'verify'
    const updated = await this.prisma.profile.update({
      where: { id: profileId },
      data: { oabStatus: verified ? 'verified' : 'rejected', oabVerified: verified },
      select: { oabStatus: true, oabVerified: true },
    })
    await this.prisma.auditLog.create({
      data: {
        profileId,
        action: verified ? 'oab:verified' : 'oab:rejected',
        complianceStatus: 'ok',
        policyVersion: POLICY_VERSION,
        bioSnapshot: reason ?? '', // reaproveita a coluna de nota p/ o motivo da decisão
      },
    })
    return updated
  }

  search(q?: string, area?: string) {
    return this.prisma.profile.findMany({
      where: {
        published: true,
        ...(area ? { areas: { some: { label: area } } } : {}),
        // `contains` portável entre SQLite (dev) e Postgres. No SQLite o LIKE já é
        // case-insensitive p/ ASCII; em produção Postgres, use índice lower()/citext
        // para busca acento/caixa-insensível sem depender de `mode` (provider-specific).
        ...(q
          ? {
              OR: [
                { name: { contains: q } },
                { city: { contains: q } },
                { areas: { some: { label: { contains: q } } } },
              ],
            }
          : {}),
      },
      // Ordenação por critério objetivo e não-comercial (alfabético por nome).
      // Prov. 205/2021 Art.5º §1º veda pagamento por destaque/posição em rankings —
      // por isso NÃO ordenamos por plano de assinatura. Ver REGRAS.md §3.
      orderBy: [{ name: 'asc' }],
      take: 40,
      select: {
        slug: true,
        name: true,
        oabNumber: true,
        oabVerified: true,
        headline: true,
        city: true,
        state: true,
        avatarUrl: true,
        areas: { select: { label: true }, orderBy: { order: 'asc' } },
      },
    })
  }
}
