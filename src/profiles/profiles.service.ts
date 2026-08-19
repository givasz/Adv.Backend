import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { complianceStatus, POLICY_VERSION, RULESET_REV } from '../oab/compliance'
import {
  AREA_LIMIT,
  ARTICLE_LIMIT,
  ARTICLE_SUMMARY_MAX,
  ARTICLE_TITLE_MAX,
  canUseScheduling,
  countLimit,
  HIGHLIGHT_LIMIT,
  limitsFor,
  NAME_MAX,
  resolveTheme,
  OAB_MAX,
  slugify,
  type LimitedField,
  type Plan,
} from '../plans'
import { canUseVideo, normalizeVideoUrl, VIDEO_CAPTION_MAX } from '../video'

const relations = {
  areas: { orderBy: { order: 'asc' as const } },
  highlights: { orderBy: { order: 'asc' as const } },
  articles: { orderBy: { order: 'asc' as const } },
  socials: true,
}

// Planos aceitos na troca de assinatura (POST /profiles/me/plan).
const PLANS: Plan[] = ['free', 'pro', 'premium']

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
    if (set.has('articles')) out.articles = []
    if (set.has('video')) {
      out.videoUrl = null
      out.videoCaption = ''
    }
    if (set.has('socials')) out.socials = []
    if (set.has('areas')) out.areas = []
    else if (out.areas) out.areas = out.areas.filter((a: { id: string }) => !set.has(`area:${a.id}`))
    return out
  }

  // Dias da semana da agenda: coluna JSON → number[] (0=dom … 6=sáb). Tolerante a lixo.
  private parseWeekdays(raw: unknown): number[] {
    try {
      const parsed = JSON.parse(typeof raw === 'string' ? raw : '[1,2,3,4,5]')
      if (Array.isArray(parsed)) {
        return parsed.filter((n): n is number => Number.isInteger(n) && n >= 0 && n <= 6)
      }
    } catch {
      /* JSON inválido → padrão seg–sex */
    }
    return [1, 2, 3, 4, 5]
  }

  private sanitizeMode(mode: unknown, plan: string | undefined): string {
    // Agendamento (assistente, formulário ou link externo) é recurso pago: no Free, força 'off'.
    if (!canUseScheduling(plan)) return 'off'
    // Compat: a agenda-calendário ('native') virou o formulário rápido ('whatsapp').
    if (mode === 'native') return 'whatsapp'
    return mode === 'off' || mode === 'whatsapp' || mode === 'assistant' || mode === 'external'
      ? mode
      : 'external'
  }

  // Grade do assistente virtual → colunas planas, com limites de sanidade. Dias sem
  // horário válido são descartados: o assistente nunca oferece um dia vazio.
  private assistantCols(a: any) {
    const clampInt = (v: unknown, min: number, max: number, dflt: number) => {
      const n = Math.round(Number(v))
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt
    }
    const isTime = (t: unknown): t is string =>
      typeof t === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(t.trim())

    const byWeekday = new Map<number, string[]>()
    for (const day of Array.isArray(a?.days) ? a.days : []) {
      const wd = Number(day?.weekday)
      if (!Number.isInteger(wd) || wd < 0 || wd > 6) continue
      const raw: unknown[] = Array.isArray(day?.times) ? day.times : []
      const times = [...new Set(raw.filter(isTime))].sort()
      if (!times.length) continue
      byWeekday.set(wd, times)
    }
    const days = [...byWeekday.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([weekday, times]) => ({ weekday, times }))

    return {
      assistantDays: JSON.stringify(days),
      assistantDurationMin: clampInt(a?.durationMin, 15, 180, 45),
      assistantLeadHours: clampInt(a?.leadHours, 0, 168, 12),
      assistantHorizonDays: clampInt(a?.horizonDays, 1, 90, 14),
      assistantGreeting: String(a?.greeting ?? '').slice(0, 180),
    }
  }

  // Colunas planas → objeto `assistant` do frontend.
  private buildAssistant(p: any) {
    let days: { weekday: number; times: string[] }[] = []
    try {
      const parsed = JSON.parse(typeof p.assistantDays === 'string' ? p.assistantDays : '[]')
      if (Array.isArray(parsed)) days = parsed
    } catch {
      /* JSON inválido → grade vazia (o front cai no padrão) */
    }
    return {
      days,
      durationMin: p.assistantDurationMin ?? 45,
      leadHours: p.assistantLeadHours ?? 12,
      horizonDays: p.assistantHorizonDays ?? 14,
      greeting: p.assistantGreeting ?? '',
    }
  }

  // Normaliza a config da agenda vinda do front em colunas planas, com limites de
  // sanidade (evita expediente invertido, slots absurdos, horizonte gigante).
  private bookingCols(b: any) {
    const clampInt = (v: unknown, min: number, max: number, dflt: number) => {
      const n = Math.round(Number(v))
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt
    }
    const weekdays = Array.isArray(b?.weekdays)
      ? b.weekdays.filter((n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 6)
      : [1, 2, 3, 4, 5]
    let startMin = clampInt(b?.startMin, 0, 1439, 540)
    let endMin = clampInt(b?.endMin, 1, 1440, 1080)
    if (endMin <= startMin) {
      startMin = 540
      endMin = 1080
    }
    return {
      bookingWeekdays: JSON.stringify([...new Set<number>(weekdays)].sort((a, b) => a - b)),
      bookingStartMin: startMin,
      bookingEndMin: endMin,
      bookingSlotMin: clampInt(b?.slotMin, 10, 240, 30),
      bookingLeadHours: clampInt(b?.leadHours, 0, 720, 12),
      bookingHorizonDays: clampInt(b?.horizonDays, 1, 180, 30),
    }
  }

  // Reconstrói o objeto `branding` (white-label) a partir das colunas planas.
  // Perk exclusivo do Max: fora dele o objeto some da resposta, mas as colunas
  // continuam no banco — quem faz downgrade e volta reencontra sua marca intacta.
  private buildBranding(p: any) {
    if (p.plan !== 'premium') return undefined
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
      // Vídeo é perk do Max: fora dele some da resposta, mas a coluna continua no
      // banco — quem rebaixa e volta reencontra o link (mesma regra do branding).
      videoUrl: canUseVideo(p.plan) ? (p.videoUrl ?? undefined) : undefined,
      videoCaption: canUseVideo(p.plan) ? p.videoCaption || undefined : undefined,
      articles: (p.articles ?? []).map((a: any) => ({
        id: a.id,
        title: a.title,
        summary: a.summary,
        readingMinutes: a.readingMinutes,
        url: a.url ?? undefined,
      })),
      socials: (p.socials ?? []).map((s: any) => ({ kind: s.kind, url: s.url })),
      contact: {
        whatsapp: p.whatsapp ?? undefined,
        email: p.email ?? undefined,
        scheduling: p.scheduling ?? undefined,
      },
      schedulingMode: p.schedulingMode ?? 'external',
      booking: {
        weekdays: this.parseWeekdays(p.bookingWeekdays),
        startMin: p.bookingStartMin ?? 540,
        endMin: p.bookingEndMin ?? 1080,
        slotMin: p.bookingSlotMin ?? 30,
        leadHours: p.bookingLeadHours ?? 12,
        horizonDays: p.bookingHorizonDays ?? 30,
      },
      assistant: this.buildAssistant(p),
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
  // O `plan` vem SEMPRE do banco (assinatura vigente) — nunca do corpo da requisição.
  private enforceCharLimits(data: any, plan: Plan) {
    // Tetos fixos (não dependem do plano) — sanidade/anti-abuso.
    if (data.name && data.name.length > NAME_MAX) {
      throw new BadRequestException(`O nome excede o limite de ${NAME_MAX} caracteres.`)
    }
    if (data.oabNumber && data.oabNumber.length > OAB_MAX) {
      throw new BadRequestException(`O número da OAB excede o limite de ${OAB_MAX} caracteres.`)
    }

    const lim = limitsFor(plan)
    const check = (value: string | undefined, field: LimitedField, label: string) => {
      if (value && value.length > lim[field]) {
        throw new BadRequestException(
          `${label} excede o limite de ${lim[field]} caracteres do plano ${plan}.`,
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

  // Artigos educativos → linhas prontas para o Prisma, cortadas no limite do plano.
  // Fora do Max a lista vem vazia: o recurso é exclusivo do plano alto e o downgrade
  // apenas ESCONDE (não apaga textos do usuário sem aviso — ele reenvia ao voltar).
  private articleRows(raw: unknown, plan: Plan) {
    const max = countLimit(ARTICLE_LIMIT, plan)
    if (max === 0) return []
    const list = Array.isArray(raw) ? raw : []
    return list
      .filter((a: any) => typeof a?.title === 'string' && a.title.trim())
      .slice(0, max)
      .map((a: any, order: number) => ({
        title: String(a.title).slice(0, ARTICLE_TITLE_MAX),
        summary: String(a.summary ?? '').slice(0, ARTICLE_SUMMARY_MAX),
        readingMinutes: Math.min(90, Math.max(1, Math.round(Number(a.readingMinutes) || 3))),
        url: typeof a.url === 'string' && /^https?:\/\//i.test(a.url.trim()) ? a.url.trim() : null,
        order,
      }))
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
    /**
     * Só no upgrade de plano: descarta o sufixo numérico que o Free impõe. É a
     * plataforma que o coloca, não o advogado — mantê-lo depois de assinar deixaria
     * o perk "seu nome no endereço, sem número" sem efeito nenhum. Num save comum
     * fica desligado, senão um endereço legitimamente terminado em número (ex.:
     * joao-silva-2020, escolhido à mão) seria alterado sem o usuário pedir.
     */
    stripAutoNumber = false,
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
      // O sufixo numérico do Free (nome-1234) é imposto pela plataforma, não é uma
      // escolha do advogado: ao subir de plano ele cai fora e o endereço volta a ser
      // o nome limpo — que é exatamente o que o Pro promete. Sem isto, quem assinava
      // continuava com o número e o perk não aparecia em lugar nenhum.
      const desired = (desiredSlug || '').trim()
      const autoNumbered =
        stripAutoNumber && !!nameBase && new RegExp(`^${nameBase}-\\d+$`).test(desired)
      const base = slugify(!desired || autoNumbered ? name || '' : desired)
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

  /**
   * O endereço desejado está livre? Usado pelo editor enquanto o advogado digita
   * e pelo painel, que antes AFIRMAVA "disponível" sem ter perguntado a ninguém —
   * com dois "joão-silva" no país, a promessa quebrava no primeiro save.
   *
   * `suggested` devolve o que o servidor realmente gravaria (mesma escada do
   * resolveSlug), para a interface poder mostrar a alternativa em vez de só negar.
   * Não vaza nada: perfis publicados já são acessíveis por slug.
   */
  async slugAvailability(userId: string, rawSlug: string, rawName?: string) {
    // slugify() nunca devolve vazio (cai em "perfil"), então a checagem de campo
    // em branco tem de ser feita ANTES — senão um input vazio respondia
    // "disponível" para um endereço que o usuário não pediu.
    if (!(rawSlug ?? '').trim()) {
      return { slug: '', available: false, suggested: '', reason: 'empty' }
    }
    const desired = slugify(rawSlug!)

    const owner = await this.prisma.profile.findUnique({
      where: { slug: desired },
      select: { userId: true },
    })
    const available = owner === null || owner.userId === userId
    // O nome vem junto porque a sugestão é derivada dele (nome + número), como no save.
    // A sugestão parte do NOME, com o sufixo automático descartado: sem isso,
    // pedir "carla-duarte-4986" devolvia "carla-duarte-4986-1930" — número em
    // cima de número, que não é endereço que ninguém queira.
    const suggested = available
      ? desired
      : await this.resolveSlug(rawName || desired, 'pro', desired, userId, true)
    return { slug: desired, available, suggested, reason: available ? 'free' : 'taken' }
  }

  async update(userId: string, data: any) {
    // O PLANO É DO SERVIDOR: vem da assinatura gravada no banco, nunca do corpo da
    // requisição. Antes, um `plan: "premium"` no JSON liberava limites e recursos —
    // e, do outro lado, a assinatura simulada não sobrevivia ao recarregar a página
    // (o update não gravava o plano). A troca de plano agora tem porta própria:
    // POST /api/profiles/me/plan → setPlan().
    const current = await this.prisma.profile.findUnique({
      where: { userId },
      select: { moderationStatus: true, plan: true },
    })
    // Perfil restrito pela moderação não pode ser republicado pelo dono.
    if (data.published && current?.moderationStatus === 'restricted') {
      throw new ForbiddenException(
        'Este perfil foi restringido pela moderação e não pode ser publicado. Fale com o suporte para revisão.',
      )
    }
    const plan: Plan = (current?.plan as Plan) ?? 'free'
    // Fonte da verdade dos limites por plano.
    this.enforceCharLimits(data, plan)
    const slug = await this.resolveSlug(data.name, plan, data.slug, userId)

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
        // Agendamento — modo + config da agenda nativa (colunas planas).
        schedulingMode: this.sanitizeMode(data.schedulingMode, plan),
        ...this.bookingCols(data.booking),
        ...this.assistantCols(data.assistant),
        // Tema é gated por plano: o editor deixa PROVAR um tema travado na
        // prévia, e é aqui que a prova para de ser prova.
        theme: resolveTheme(data.theme, plan),
        // Só grava o vídeo no Max e só se o link for de um provedor aceito. Um
        // link recusado limpa o campo em vez de persistir lixo.
        videoUrl: canUseVideo(plan) ? normalizeVideoUrl(data.videoUrl) : null,
        videoCaption: canUseVideo(plan)
          ? String(data.videoCaption ?? '').slice(0, VIDEO_CAPTION_MAX)
          : '',
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
          create: (data.areas ?? [])
            .slice(0, countLimit(AREA_LIMIT, plan))
            .map((a: any, order: number) => ({
              label: a.label,
              description: a.description,
              order,
            })),
        },
        highlights: {
          deleteMany: {},
          create: (data.highlights ?? [])
            .slice(0, countLimit(HIGHLIGHT_LIMIT, plan))
            .map((h: any, order: number) => ({
              title: h.title,
              detail: h.detail,
              order,
            })),
        },
        articles: {
          deleteMany: {},
          create: this.articleRows(data.articles, plan),
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

  /**
   * Troca o plano da assinatura. Hoje é uma ATIVAÇÃO SIMULADA (plataforma em teste,
   * sem cobrança): o checkout do front confirma e chama aqui. Quando entrar o billing
   * real, este é o único ponto que muda — o webhook do provedor chama este método.
   *
   * É a ÚNICA porta que grava `Profile.plan`: o PUT /profiles/me ignora o plano do
   * corpo. Ao rebaixar, o estado incompatível é reconciliado na hora (agendamento
   * desligado no Free, endereço renumerado) para o perfil público nunca prometer o
   * que o plano não entrega. Conteúdo (marca, artigos) é só ESCONDIDO na leitura.
   */
  async setPlan(userId: string, plan: unknown) {
    if (typeof plan !== 'string' || !PLANS.includes(plan as Plan)) {
      throw new BadRequestException('Plano inválido.')
    }
    const next = plan as Plan
    const current = await this.prisma.profile.findUnique({
      where: { userId },
      select: { plan: true, name: true, slug: true, schedulingMode: true, theme: true },
    })
    if (!current) throw new NotFoundException('Perfil não encontrado')
    if (current.plan === next) {
      const same = await this.prisma.profile.findUnique({ where: { userId }, include: relations })
      return this.toApi(same)
    }

    // Endereço: o Free é sempre numerado; ao subir de plano o advogado ganha o nome
    // limpo (se estiver livre). Reaproveita a mesma escada do save.
    const slug = await this.resolveSlug(current.name, next, current.slug, userId, true)

    const updated = await this.prisma.profile.update({
      where: { userId },
      data: {
        plan: next,
        slug,
        // Agendamento é recurso pago: cair para o Free desliga o botão do perfil.
        schedulingMode: this.sanitizeMode(current.schedulingMode, next),
        // Tema de plano superior não sobrevive ao downgrade — volta ao neutro.
        theme: resolveTheme(current.theme, next),
      },
      include: relations,
    })

    // Trilha de auditoria: a mudança de plano altera o que o perfil pode exibir.
    await this.prisma.auditLog.create({
      data: {
        profileId: updated.id,
        action: 'plan',
        complianceStatus: 'ok',
        policyVersion: POLICY_VERSION,
        bioSnapshot: `${current.plan} → ${next}`,
      },
    })

    return this.toApi(updated)
  }

  // A conferência de OAB (workflow none → pending → verified/rejected) foi movida para
  // um módulo desacoplado: ver src/oab/verification/oab-verification.service.ts.

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
