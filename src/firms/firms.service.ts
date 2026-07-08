import { Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { firmMonthlyPrice } from '../plans'

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
