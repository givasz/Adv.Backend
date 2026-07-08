import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { FIRM_PRICING, firmMonthlyPrice, slugify } from '../plans'
import { hasBlockingIssue } from '../oab/compliance'

// Serviço da página institucional do escritório. Monta o shape público consumido
// pelo frontend (ver frontend/src/lib/escritorio.ts): dados institucionais + grid de
// advogados ATIVOS em ordem alfabética (nunca por senioridade — Prov. 205/2021).
@Injectable()
export class FirmsService {
  constructor(private readonly prisma: PrismaService) {}

  async getBySlug(slug: string) {
    const firm = await this.prisma.firm.findUnique({
      where: { slug },
      include: {
        members: {
          where: { status: 'active' },
          include: {
            profile: {
              include: {
                areas: { orderBy: { order: 'asc' } },
                socials: true,
              },
            },
          },
        },
      },
    })
    if (!firm) throw new NotFoundException('Escritório não encontrado')
    return this.toApi(firm)
  }

  // Escritório do dono (para o editor). Null se ainda não criou.
  async getMine(ownerUserId: string) {
    const firm = await this.prisma.firm.findFirst({
      where: { ownerUserId },
      select: { slug: true },
    })
    return firm ? this.getBySlug(firm.slug) : null
  }

  private async resolveFirmSlug(name: string, selfId?: string) {
    const base = slugify(name || '') || 'escritorio'
    const taken = async (s: string) => {
      const f = await this.prisma.firm.findUnique({ where: { slug: s }, select: { id: true } })
      return f !== null && f.id !== selfId
    }
    if (!(await taken(base))) return base
    let n = 2
    while (await taken(`${base}-${n}`)) n++
    return `${base}-${n}`
  }

  private async resolveMemberSlug(name: string) {
    const base = slugify(name || '') || 'advogado'
    const rnd = () => Math.floor(1000 + Math.random() * 9000)
    let s = `${base}-${rnd()}`
    while (await this.prisma.profile.findUnique({ where: { slug: s }, select: { id: true } })) {
      s = `${base}-${rnd()}`
    }
    return s
  }

  // Cria ou atualiza o escritório do dono. Guarda-corpo de conformidade no texto
  // institucional + bios; slug único; reconcilia os advogados como perfis-membros.
  async createOrUpdate(ownerUserId: string, data: any) {
    const texts = [data.tagline, data.about, ...(data.lawyers ?? []).map((l: any) => l.bio)]
    if (texts.some((t: string) => t && hasBlockingIssue(t))) {
      throw new BadRequestException(
        'O texto do escritório contém termos vedados pela OAB (Prov. 205/2021). Ajuste antes de salvar.',
      )
    }
    // Garante o usuário dono (protótipo: DEMO_USER, sem auth real).
    await this.prisma.user.upsert({
      where: { id: ownerUserId },
      update: {},
      create: { id: ownerUserId, email: `${ownerUserId}@demo.local`, password: 'demo' },
    })

    const existing = await this.prisma.firm.findFirst({ where: { ownerUserId }, select: { id: true } })
    const slug = await this.resolveFirmSlug(data.name, existing?.id)
    const seats = Math.max(FIRM_PRICING.includedSeats, (data.lawyers ?? []).length)
    const c = data.contact ?? {}
    const fields = {
      name: data.name ?? '',
      slug,
      oabRegistry: data.oabRegistry ?? '',
      monogram: data.monogram ?? '',
      tagline: data.tagline ?? '',
      about: data.about ?? '',
      city: data.city ?? '',
      state: data.state ?? '',
      phone: c.phone ?? null,
      email: c.email ?? null,
      whatsapp: c.whatsapp ?? null,
      instagram: c.instagram ?? null,
      linkedin: c.linkedin ?? null,
      brandAccent: data.brandAccent ?? null,
      customDomain: data.customDomain ?? null,
      seatsPurchased: seats,
    }
    const firm = existing
      ? await this.prisma.firm.update({ where: { id: existing.id }, data: fields })
      : await this.prisma.firm.create({ data: { ...fields, ownerUserId } })

    await this.reconcileLawyers(firm.id, data.lawyers ?? [])
    return this.getBySlug(firm.slug)
  }

  // Reconcilia os advogados (embutidos no editor) com perfis-membros no banco:
  // casa por número de OAB (atualiza), cria os novos, remove os que saíram.
  private async reconcileLawyers(firmId: string, lawyers: any[]) {
    const existing = await this.prisma.firmMembership.findMany({
      where: { firmId },
      include: { profile: { select: { id: true, oabNumber: true } } },
    })
    const byOab = new Map(existing.map((m) => [m.profile.oabNumber, m]))
    const keep = new Set<string>()

    for (const l of lawyers) {
      const areasCreate = l.area ? [{ label: l.area, description: '', order: 0 }] : []
      const socialsCreate = l.linkedin ? [{ kind: 'linkedin' as const, url: l.linkedin }] : []
      const match = l.oabNumber ? byOab.get(l.oabNumber) : undefined
      if (match) {
        keep.add(match.id)
        await this.prisma.profile.update({
          where: { id: match.profile.id },
          data: {
            name: l.name ?? '',
            bio: l.bio ?? '',
            avatarUrl: l.avatarUrl ?? null,
            oabVerified: !!l.oabVerified,
            areas: { deleteMany: {}, create: areasCreate },
            socials: { deleteMany: {}, create: socialsCreate },
          },
        })
      } else {
        const mslug = await this.resolveMemberSlug(l.name)
        const uid = `firm-${firmId}-${Math.random().toString(36).slice(2, 8)}`
        await this.prisma.user.create({
          data: {
            id: uid,
            email: `${uid}@members.local`,
            password: 'member',
            profile: {
              create: {
                slug: mslug,
                name: l.name ?? '',
                oabNumber: l.oabNumber ?? '',
                oabVerified: !!l.oabVerified,
                bio: l.bio ?? '',
                avatarUrl: l.avatarUrl ?? null,
                published: true,
                plan: 'pro',
                areas: { create: areasCreate },
                socials: { create: socialsCreate },
                firmMembership: { create: { firmId, status: 'active', role: 'member' } },
              },
            },
          },
        })
      }
    }
    // Remove quem saiu (apaga o perfil → cascata na FirmMembership).
    for (const m of existing) {
      if (!keep.has(m.id)) {
        await this.prisma.profile.delete({ where: { id: m.profile.id } }).catch(() => {})
      }
    }
  }

  // Solicita a conferência do registro da SOCIEDADE (workflow separado da OAB individual).
  async requestOab(ownerUserId: string) {
    const firm = await this.prisma.firm.findFirst({
      where: { ownerUserId },
      select: { id: true, oabStatus: true },
    })
    if (!firm) throw new NotFoundException('Escritório não encontrado')
    if (firm.oabStatus === 'verified') return { oabStatus: 'verified' as const }
    const u = await this.prisma.firm.update({
      where: { id: firm.id },
      data: { oabStatus: 'pending' },
      select: { oabStatus: true },
    })
    return { oabStatus: u.oabStatus }
  }

  private toApi(firm: any) {
    // Advogados ativos → shape do card/mini-perfil. Área exibida = 1ª área do perfil.
    const lawyers = firm.members
      .map((m: any) => {
        const p = m.profile
        const linkedin = (p.socials ?? []).find((s: any) => s.kind === 'linkedin')?.url
        return {
          id: p.id,
          name: p.name,
          oabNumber: p.oabNumber,
          oabVerified: p.oabVerified, // verificação INDIVIDUAL (≠ registro da sociedade)
          area: p.areas?.[0]?.label ?? '',
          bio: p.bio ?? '',
          avatarUrl: p.avatarUrl ?? undefined,
          linkedin,
        }
      })
      // Ordem NEUTRA (alfabética) — sem hierarquia por senioridade/destaque.
      .sort((a: any, b: any) => a.name.localeCompare(b.name, 'pt-BR'))

    // Áreas de triagem derivadas das áreas principais dos advogados (distintas).
    const areas = Array.from(new Set(lawyers.map((l: any) => l.area).filter(Boolean)))
      .sort((a, b) => (a as string).localeCompare(b as string, 'pt-BR'))
      .map((label) => ({ id: label as string, label: label as string }))

    return {
      slug: firm.slug,
      name: firm.name,
      oabRegistry: firm.oabRegistry,
      oabVerified: firm.oabVerified, // verificação da SOCIEDADE
      monogram: firm.monogram,
      tagline: firm.tagline,
      about: firm.about,
      city: firm.city,
      state: firm.state,
      contact: {
        phone: firm.phone ?? undefined,
        email: firm.email ?? undefined,
        whatsapp: firm.whatsapp ?? undefined,
        instagram: firm.instagram ?? undefined,
        linkedin: firm.linkedin ?? undefined,
      },
      // White-label herdado do escritório (aplicado na página).
      brandAccent: firm.brandAccent ?? undefined,
      customDomain: firm.customDomain ?? undefined,
      areas,
      lawyers,
      // Metadados de plano/assentos (usados por área administrativa; inócuos ao público).
      seats: { purchased: firm.seatsPurchased, used: lawyers.length },
      monthlyPrice: firmMonthlyPrice(Math.max(firm.seatsPurchased, lawyers.length)),
    }
  }
}
