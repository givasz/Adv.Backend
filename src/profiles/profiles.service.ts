import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { complianceStatus, POLICY_VERSION, RULESET_REV } from '../oab/compliance'
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
    // Perfil restrito pela moderação some do público (equiparado a não publicado).
    const profile = await this.prisma.profile.findFirst({
      where: { slug, published: true, moderationStatus: { not: 'restricted' } },
      include: relations,
    })
    if (!profile) throw new NotFoundException('Perfil não encontrado')
    // registra a visita de forma assíncrona (não bloqueia a resposta)
    void this.prisma.linkEvent.create({ data: { profileId: profile.id, kind: 'view' } })
    return this.toApi(this.toPublic(profile))
  }

  // Aplica a censura parcial (moderationStatus == partial) e remove os campos
  // internos de moderação antes de devolver o perfil ao público.
  private toPublic<
    T extends {
      moderationStatus: string
      hiddenSections: string
      avatarUrl?: string | null
      headline?: string
      bio?: string
      regionNote?: string | null
      areas?: { id: string }[]
      highlights?: unknown[]
      socials?: unknown[]
    },
  >(profile: T) {
    const { hiddenSections, moderationNote, moderationStatus, ...rest } = profile as T & {
      moderationNote?: string
    }
    if (moderationStatus !== 'partial') return rest

    let hidden: string[] = []
    try {
      const parsed = JSON.parse(hiddenSections || '[]')
      if (Array.isArray(parsed)) hidden = parsed.filter((s): s is string => typeof s === 'string')
    } catch {
      /* JSON inválido → nada censurado */
    }
    const set = new Set(hidden)
    // Sinaliza ao público que há censura (sem revelar o quê nem a nota do admin).
    const out: any = { ...rest, contentModerated: true }
    if (set.has('avatar')) out.avatarUrl = null
    if (set.has('headline')) out.headline = ''
    if (set.has('bio')) out.bio = ''
    if (set.has('regionNote')) out.regionNote = null
    if (set.has('highlights')) out.highlights = []
    if (set.has('socials')) out.socials = []
    if (set.has('areas')) out.areas = []
    else if (out.areas) out.areas = out.areas.filter((a: { id: string }) => !set.has(`area:${a.id}`))
    return out
  }

  // Reconstrói o objeto `branding` (white-label) a partir das colunas planas.
  private buildBranding(p: any) {
    const b: Record<string, unknown> = {}
    if (p.brandName) b.brandName = p.brandName
    if (p.brandAccent) b.accent = p.brandAccent
    if (p.brandHideWatermark) b.hideWatermark = true
    if (p.customDomain) b.customDomain = p.customDomain
    return Object.keys(b).length ? b : undefined
  }

  // Mapeia a linha (plana) do Prisma para o shape ANINHADO esperado pelo frontend
  // (serviceMode/contact/branding + coleções filhas). Ver frontend/src/lib/types.ts.
  // Usado nos retornos públicos (getBySlug/getMine/update); a moderação tem shape
  // próprio (ModerationProfile) e NÃO passa por aqui.
  private toApi(p: any) {
    const out: any = {
      slug: p.slug,
      name: p.name,
      oabNumber: p.oabNumber,
      oabVerified: p.oabVerified,
      oabStatus: p.oabStatus,
      headline: p.headline ?? '',
      bio: p.bio ?? '',
      avatarUrl: p.avatarUrl ?? undefined,
      city: p.city ?? '',
      state: p.state ?? '',
      regionNote: p.regionNote ?? undefined,
      serviceMode: { inPerson: !!p.inPerson, online: !!p.online },
      areas: (p.areas ?? []).map((a: any) => ({
        id: a.id,
        label: a.label,
        description: a.description,
      })),
      highlights: (p.highlights ?? []).map((h: any) => ({
        id: h.id,
        title: h.title,
        detail: h.detail,
      })),
      socials: (p.socials ?? []).map((s: any) => ({ kind: s.kind, url: s.url })),
      contact: {
        whatsapp: p.whatsapp ?? undefined,
        email: p.email ?? undefined,
        scheduling: p.scheduling ?? undefined,
      },
      plan: p.plan,
      theme: p.theme,
      views: p.views,
      published: p.published,
      policyRevChecked: p.policyRevChecked,
      branding: this.buildBranding(p),
    }
    // Campos do dono (getMine) — ausentes no público (toPublic os remove).
    if (p.moderationStatus !== undefined) out.moderationStatus = p.moderationStatus
    if (p.moderationNote) out.moderationNote = p.moderationNote
    if (p.contentModerated) out.contentModerated = true
    return out
  }

  async getMine(userId: string) {
    const p = await this.prisma.profile.findUnique({ where: { userId }, include: relations })
    return p ? this.toApi(p) : null
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

  private randomSuffix(): number {
    return Math.floor(1000 + Math.random() * 9000) // 4 dígitos
  }

  // Escada de endereço:
  //  • Free → sempre nome + número ALEATÓRIO (ex.: marina-sales-4827), não editável.
  //  • Pro/Max → endereço EDITÁVEL: usa o slug desejado se estiver livre; senão nome + aleatório.
  //  (Max ainda tem o domínio próprio como diferencial exclusivo.)
  private async resolveSlug(
    name: string,
    plan: string | undefined,
    desiredSlug: string | undefined,
    selfUserId: string,
  ) {
    const nameBase = slugify(name ?? '')
    const takenByOther = async (slug: string) => {
      const p = await this.prisma.profile.findUnique({ where: { slug }, select: { userId: true } })
      return p !== null && p.userId !== selfUserId
    }
    const withRandom = async (base: string) => {
      let s = `${base}-${this.randomSuffix()}`
      while (await takenByOther(s)) s = `${base}-${this.randomSuffix()}`
      return s
    }

    if (plan === 'pro' || plan === 'premium') {
      const base = slugify(desiredSlug || name || '')
      if (!(await takenByOther(base))) return base // endereço desejado disponível
      return withRandom(base) // ocupado → nome + aleatório
    }

    // Free: mantém o slug atual se já for "nome-<número>" do nome vigente; senão gera novo.
    const current = (desiredSlug || '').trim()
    if (current && new RegExp(`^${nameBase}-\\d+$`).test(current) && !(await takenByOther(current))) {
      return current
    }
    return withRandom(nameBase)
  }

  async update(userId: string, data: any) {
    // Perfil restrito pela moderação não pode ser republicado pelo dono.
    if (data.published) {
      const current = await this.prisma.profile.findUnique({
        where: { userId },
        select: { moderationStatus: true },
      })
      if (current?.moderationStatus === 'restricted') {
        throw new ForbiddenException(
          'Este perfil foi restringido pela moderação e não pode ser publicado. Fale com o suporte para revisão.',
        )
      }
    }
    // Fonte da verdade dos limites por plano.
    this.enforceCharLimits(data)
    const slug = await this.resolveSlug(data.name, data.plan, data.slug, userId)

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
        // Carimba a revisão vigente das regras (monitor normativo): ao salvar, o
        // perfil passa a estar "em dia" com o RULESET_REV atual.
        policyRevChecked: RULESET_REV,
        // Identidade própria (white-label) — persistida em colunas planas.
        brandName: data.branding?.brandName ?? null,
        brandAccent: data.branding?.accent ?? null,
        brandHideWatermark: data.branding?.hideWatermark ?? false,
        customDomain: data.branding?.customDomain ?? null,
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

    return this.toApi(updated)
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

  // Busca do PAINEL ADMIN: ao contrário do diretório público, retorna perfis de
  // qualquer status (não publicados, restritos etc.) para o moderador localizar e agir.
  adminSearch(q?: string) {
    const query = (q ?? '').trim()
    return this.prisma.profile.findMany({
      where: query
        ? {
            OR: [
              { name: { contains: query } },
              { slug: { contains: query } },
              { oabNumber: { contains: query } },
              { city: { contains: query } },
            ],
          }
        : {},
      orderBy: [{ name: 'asc' }],
      take: 50,
      select: {
        id: true,
        name: true,
        slug: true,
        oabNumber: true,
        city: true,
        state: true,
        plan: true,
        published: true,
        moderationStatus: true,
        oabStatus: true,
      },
    })
  }

  async search(q?: string, area?: string) {
    const rows = await this.prisma.profile.findMany({
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
    // DirectoryResult espera `areas: string[]` (não objetos).
    return rows.map((r) => ({ ...r, areas: r.areas.map((a) => a.label) }))
  }
}
