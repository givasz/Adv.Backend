import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { FIRM_PRICING, firmMonthlyPrice, slugify, type Plan } from '../plans'
import { ProfilesService } from '../profiles/profiles.service'
import {
  clampOrNull,
  clampText,
  safeEmail,
  safeHexColor,
  safeHostname,
  safeImageSrc,
  safePhone,
  safeUrl,
} from '../security/sanitize'
import { hasBlockingIssue } from '../oab/compliance'

// Mesmo formato aceito no cadastro (auth.service).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Tetos de texto da página institucional. Nenhum campo entra sem limite: o corpo
// do PUT é JSON livre e o que for gravado aqui é lido por visitantes.
const FIRM_NAME_MAX = 90
const MONOGRAM_MAX = 4
const REGISTRY_MAX = 40
const TAGLINE_MAX = 160
const ABOUT_MAX = 2000
const CITY_MAX = 80
const STATE_MAX = 40

// Advogado listado sem conta. O nome segue o teto do perfil individual; a área é
// um rótulo curto, não uma descrição.
const ROSTER_NAME_MAX = 70
const ROSTER_OAB_MAX = 20
const ROSTER_AREA_MAX = 60

// Serviço do escritório (sociedade de advogados).
//
// Duas verdades que mandam no desenho:
//   1. O perfil é da PESSOA, não do escritório. Entrar é aceitar um convite; sair
//      apaga o vínculo (FirmMembership) e nunca o Profile.
//   2. O grid público é alfabético, sempre — Prov. 205/2021 veda destaque e
//      hierarquia entre advogados.
@Injectable()
export class FirmsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: ProfilesService,
  ) {}

  // ---- Leitura pública ------------------------------------------------------

  async getBySlug(slug: string) {
    const firm = await this.prisma.firm.findUnique({
      where: { slug },
      include: {
        roster: { orderBy: { order: 'asc' } },
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

  // ---- Leitura para quem administra ----------------------------------------

  // Escritório que o usuário administra (dono ou admin), com a lista de membros e
  // os convites pendentes. Null se ele ainda não tem escritório.
  async getMine(userId: string) {
    const firm = await this.findManagedFirm(userId)
    return firm ? this.manageView(firm.id) : null
  }

  // Escritório administrado pelo usuário: dono OU membro ativo com papel admin.
  private async findManagedFirm(userId: string): Promise<{ id: string } | null> {
    const owned = await this.prisma.firm.findFirst({
      where: { ownerUserId: userId },
      select: { id: true },
    })
    if (owned) return owned
    const membership = await this.prisma.firmMembership.findFirst({
      where: { role: 'admin', status: 'active', profile: { userId } },
      select: { firmId: true },
    })
    return membership ? { id: membership.firmId } : null
  }

  private async requireManagedFirm(userId: string) {
    const firm = await this.findManagedFirm(userId)
    if (!firm) throw new NotFoundException('Você ainda não tem um escritório')
    return firm
  }

  // Shape do editor: o público + a gestão (membros com estado, convites, assentos).
  private async manageView(firmId: string) {
    const firm = await this.prisma.firm.findUnique({
      where: { id: firmId },
      include: {
        invites: true,
        roster: { orderBy: { order: 'asc' } },
        members: {
          include: {
            profile: {
              include: {
                areas: { orderBy: { order: 'asc' } },
                socials: true,
                user: { select: { email: true } },
              },
            },
          },
        },
      },
    })
    if (!firm) throw new NotFoundException('Escritório não encontrado')

    const ativos = firm.members.filter((m) => m.status === 'active')
    const publico = this.toApi({ ...firm, members: ativos })

    // Vínculos reais + convites por e-mail (quem ainda não tem conta) na MESMA
    // lista: para o dono, os dois são "gente que ele chamou".
    const members = [
      ...firm.members.map((m: any) => ({
        id: m.id,
        kind: 'membership' as const,
        name: m.profile.name || m.profile.user?.email || 'Advogado(a)',
        email: m.profile.user?.email ?? undefined,
        oabNumber: m.profile.oabNumber || undefined,
        area: m.profile.areas?.[0]?.label ?? '',
        role: m.role,
        status: m.status,
        profileSlug: m.profile.slug,
      })),
      // Convite cujo e-mail já pertence a alguém LISTADO não vira linha própria:
      // seria a mesma pessoa duas vezes na tela do dono — uma pelo nome ("Marina
      // Sales") e outra pelo endereço ("marina@..."), sem nada dizendo que são a
      // mesma. Quem representa os dois é a linha do roster, que tem o nome.
      ...firm.invites
        .filter((i) => !(firm.roster ?? []).some((r) => r.email === i.email))
        .map((i) => ({
          id: i.id,
          kind: 'invite' as const,
          name: i.email,
          email: i.email,
          role: i.role,
          status: 'invited' as const,
        })),
      // Listados sem conta. Entram na mesma lista porque, para quem administra,
      // são o quadro do escritório como qualquer outro — o que muda é o que dá
      // para fazer com cada um, e o `kind` é que diz isso à tela.
      ...(firm.roster ?? []).map((r) => ({
        id: r.id,
        kind: 'roster' as const,
        name: r.name,
        email: r.email ?? undefined,
        oabNumber: r.oabNumber || undefined,
        area: r.area,
        role: r.role,
        status: (r.email ? 'invited' : 'listed') as 'invited' | 'listed',
      })),
    ].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')) // ordem neutra, aqui também

    // Listado sem conta ocupa assento (aparece no grid, que é o que o plano
    // vende). Os que já receberam e-mail viraram convite e seriam contados duas
    // vezes — ver syncSeats, que usa a mesma regra.
    const listadosSemConta = (firm.roster ?? []).filter((r) => !r.email).length
    const ocupados = firm.members.length + firm.invites.length + listadosSemConta
    return {
      ...publico,
      members,
      seats: { purchased: Math.max(firm.seatsPurchased, ocupados), used: ocupados },
      monthlyPrice: firmMonthlyPrice(Math.max(FIRM_PRICING.includedSeats, ocupados)),
    }
  }

  // ---- Criação / edição institucional --------------------------------------

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

  // Cria ou atualiza os dados INSTITUCIONAIS do escritório. A lista de advogados
  // não vem mais no corpo: membro entra por convite e cada um edita o próprio
  // perfil (ver invite/removeMember abaixo).
  async createOrUpdate(userId: string, data: any) {
    // O NOME da sociedade entra na checagem junto com os textos: ele é a linha mais
    // visível da página institucional, e "Advocacia Vitória Certa" é publicidade
    // irregular tanto quanto a mesma frase no corpo do texto.
    const d = data && typeof data === 'object' ? data : {}
    const nome = clampText(d.name, FIRM_NAME_MAX)
    const tagline = clampText(d.tagline, TAGLINE_MAX)
    const about = clampText(d.about, ABOUT_MAX)
    const campos: [string, string][] = [
      ['Nome da sociedade', nome],
      ['Frase institucional', tagline],
      ['Sobre o escritório', about],
    ]
    const travados = campos.filter(([, t]) => t && hasBlockingIssue(t)).map(([label]) => label)
    if (travados.length) {
      throw new BadRequestException(
        `Há termos vedados pela OAB (Prov. 205/2021) em: ${travados.join(', ')}. Ajuste antes de salvar.`,
      )
    }
    // O dono é a conta logada (o controller já exigiu sessão). Se o usuário sumiu
    // do banco com a sessão ainda válida, é 401 — nunca criar usuário aqui.
    const owner = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, profile: { select: { id: true } } },
    })
    if (!owner) throw new UnauthorizedException('Sessão inválida: usuário não encontrado')

    const managed = await this.findManagedFirm(userId)
    const slug = await this.resolveFirmSlug(nome, managed?.id)
    const c = d.contact && typeof d.contact === 'object' ? d.contact : {}
    const fields = {
      name: nome,
      slug,
      oabRegistry: clampText(d.oabRegistry, REGISTRY_MAX),
      monogram: clampText(d.monogram, MONOGRAM_MAX),
      // A coluna existia desde o começo e NADA a gravava: o editor não
      // oferecia o campo e esta lista não a incluía, então todo escritório
      // ficava nas duas letras do monograma, sem caminho para trocar.
      //  é o mesmo saneamento da foto do advogado — só data
      // URI de imagem ou link https entram.
      logoUrl: safeImageSrc(d.logoUrl),
      tagline,
      about,
      city: clampText(d.city, CITY_MAX),
      state: clampText(d.state, STATE_MAX),
      phone: safePhone(c.phone),
      email: safeEmail(c.email),
      whatsapp: safePhone(c.whatsapp),
      // Redes viram href na página do escritório — só http/https entram.
      instagram: safeUrl(c.instagram),
      linkedin: safeUrl(c.linkedin),
      brandAccent: safeHexColor(d.brandAccent),
      customDomain: safeHostname(d.customDomain),
      assistantRoute: d.assistantRoute === 'lawyer' ? 'lawyer' : 'institutional',
    }

    if (managed) {
      await this.prisma.firm.update({ where: { id: managed.id }, data: fields })
      await this.syncSeats(managed.id)
      return this.manageView(managed.id)
    }

    const firm = await this.prisma.firm.create({
      data: { ...fields, ownerUserId: userId, seatsPurchased: FIRM_PRICING.includedSeats },
    })
    // O dono é o primeiro membro do próprio escritório, com o perfil que ele já
    // tem — nada de perfil duplicado. Se ele já estiver em outro escritório, o
    // vínculo antigo é respeitado (profileId é único) e ele fica só como dono.
    if (owner.profile) {
      await this.prisma.firmMembership
        .create({
          data: { firmId: firm.id, profileId: owner.profile.id, role: 'owner', status: 'active' },
        })
        .catch(() => {})
    }
    await this.syncSeats(firm.id)
    return this.manageView(firm.id)
  }

  // Assentos acompanham quem está dentro (ativos + convidados), com o mínimo do plano.
  private async syncSeats(firmId: string) {
    const [members, invites, listados] = await Promise.all([
      this.prisma.firmMembership.count({ where: { firmId } }),
      this.prisma.firmInvite.count({ where: { firmId } }),
      // Advogado listado sem conta OCUPA assento: ele aparece no grid público,
      // que é o que o plano vende. Não contar seria deixar um escritório listar
      // vinte pessoas pagando por cinco.
      //
      // Os que já têm e-mail associado viram convite (FirmInvite) e seriam
      // contados duas vezes — por isso só entram os que ainda não têm.
      this.prisma.firmRosterLawyer.count({ where: { firmId, email: null } }),
    ])
    const seats = Math.max(FIRM_PRICING.includedSeats, members + invites + listados)
    await this.prisma.firm.update({ where: { id: firmId }, data: { seatsPurchased: seats } })
  }

  // ---- Advogados listados sem conta (roster) --------------------------------
  //
  // Montar a página da sociedade exigia que cada advogado criasse conta e
  // aceitasse convite ANTES de aparecer. Um escritório de doze pessoas ficava com
  // a página vazia esperando doze cadastros — e o dono, sem ter o que mostrar,
  // não tinha por que assinar. Aqui ele lista quem é do quadro e a página fica
  // pronta no mesmo dia; a conta de cada um vem depois, se e quando vier.
  //
  // O dado é de TERCEIRO: nome e inscrição publicados sem a pessoa ter tocado em
  // nada. Quem responde por isso é o escritório, e o editor diz isso com todas as
  // letras. A plataforma não confere inscrição de ninguém (nem a individual) — o
  // que existe é a consulta ao CNA no perfil público e a moderação por denúncia.

  /** Acrescenta um advogado à lista da sociedade. Sem conta, sem convite. */
  async addRosterLawyer(userId: string, d: any) {
    const firm = await this.requireManagedFirm(userId)
    const name = clampText(d?.name, ROSTER_NAME_MAX)
    if (name.length < 2) throw new BadRequestException('Informe o nome do advogado.')

    // O nome vai para uma página pública e passa pela MESMA checagem do resto:
    // um "Dr. Fulano, o melhor do estado" entra por aqui se ninguém olhar.
    if (hasBlockingIssue(name)) {
      throw new BadRequestException(
        'O nome contém termo vedado pelas normas de publicidade da OAB. Use o nome como ele consta na inscrição.',
      )
    }

    const ultimo = await this.prisma.firmRosterLawyer.findFirst({
      where: { firmId: firm.id },
      orderBy: { order: 'desc' },
      select: { order: true },
    })
    await this.prisma.firmRosterLawyer.create({
      data: {
        firmId: firm.id,
        name,
        oabNumber: clampText(d?.oabNumber, ROSTER_OAB_MAX),
        area: clampText(d?.area, ROSTER_AREA_MAX),
        order: (ultimo?.order ?? -1) + 1,
      },
    })
    await this.syncSeats(firm.id)
    return this.manageView(firm.id)
  }

  /**
   * Associa um e-mail a um advogado já listado — o passo que lhe dá autonomia.
   *
   * NÃO é o mesmo que listar: listar é o escritório falando sobre a pessoa;
   * associar é convidá-la a assumir o próprio espaço. Por isso cai no fluxo de
   * convite que já existe (invite), com o papel escolhido: "admin" mexe na
   * sociedade inteira, "member" só no próprio perfil.
   *
   * A linha da lista CONTINUA no ar enquanto o convite não é aceito. Tirá-la
   * agora abriria um buraco na página até a pessoa se cadastrar — e ela pode
   * nunca se cadastrar. Quem a remove é o aceite (ver auth.service).
   */
  async linkRosterLawyer(userId: string, id: string, emailRaw?: unknown, roleRaw?: unknown) {
    const firm = await this.requireManagedFirm(userId)
    const linha = await this.prisma.firmRosterLawyer.findUnique({
      where: { id },
      select: { id: true, firmId: true },
    })
    if (!linha || linha.firmId !== firm.id) throw new NotFoundException('Advogado não encontrado.')

    const email = clampText(emailRaw, 200).toLowerCase()
    if (!EMAIL_RE.test(email)) throw new BadRequestException('Informe um e-mail válido.')
    const role = roleRaw === 'admin' ? ('admin' as const) : ('member' as const)

    // O convite é a fonte da verdade do acesso; a linha só guarda o que foi
    // pedido, para a tela poder mostrar "convite enviado para ___".
    await this.invite(userId, email, role)
    await this.prisma.firmRosterLawyer.update({ where: { id }, data: { email, role } })
    await this.syncSeats(firm.id)
    return this.manageView(firm.id)
  }

  /** Tira o advogado da lista. Não mexe em conta nenhuma — ele não tem conta. */
  async removeRosterLawyer(userId: string, id: string) {
    const firm = await this.requireManagedFirm(userId)
    const linha = await this.prisma.firmRosterLawyer.findUnique({
      where: { id },
      select: { firmId: true },
    })
    if (!linha || linha.firmId !== firm.id) throw new NotFoundException('Advogado não encontrado.')
    await this.prisma.firmRosterLawyer.delete({ where: { id } })
    await this.syncSeats(firm.id)
    return this.manageView(firm.id)
  }

  // ---- Convites -------------------------------------------------------------

  // Convida um advogado por e-mail. Já tem conta → vira FirmMembership(invited) no
  // perfil que ele JÁ tem. Ainda não tem → fica um FirmInvite, resolvido no cadastro.
  async invite(userId: string, emailRaw?: unknown, roleRaw?: unknown) {
    const firm = await this.requireManagedFirm(userId)
    const email = clampText(emailRaw, 200).toLowerCase()
    if (!EMAIL_RE.test(email)) throw new BadRequestException('Informe um e-mail válido.')
    const role = roleRaw === 'admin' ? ('admin' as const) : ('member' as const)

    const convidado = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        profile: { select: { id: true, firmMembership: { select: { firmId: true } } } },
      },
    })

    if (convidado?.profile) {
      const atual = convidado.profile.firmMembership
      if (atual?.firmId === firm.id) {
        throw new BadRequestException('Esse advogado já faz parte do seu escritório.')
      }
      if (atual) {
        throw new BadRequestException('Esse advogado já faz parte de outro escritório.')
      }
      await this.prisma.firmMembership.create({
        data: { firmId: firm.id, profileId: convidado.profile.id, role, status: 'invited' },
      })
    } else {
      await this.prisma.firmInvite.upsert({
        where: { firmId_email: { firmId: firm.id, email } },
        update: { role },
        create: { firmId: firm.id, email, role },
      })
    }

    await this.syncSeats(firm.id)
    return this.manageView(firm.id)
  }

  // Remove um vínculo ou cancela um convite por e-mail. NUNCA apaga o perfil: ele
  // é da pessoa. Quem sai volta ao plano individual que tinha antes de entrar.
  async removeMember(userId: string, kind: string, id: string) {
    const firm = await this.requireManagedFirm(userId)

    if (kind === 'invite') {
      const invite = await this.prisma.firmInvite.findUnique({
        where: { id },
        select: { firmId: true },
      })
      if (!invite || invite.firmId !== firm.id) throw new NotFoundException('Convite não encontrado')
      await this.prisma.firmInvite.delete({ where: { id } })
      await this.syncSeats(firm.id)
      return this.manageView(firm.id)
    }

    const membership = await this.prisma.firmMembership.findUnique({
      where: { id },
      select: {
        id: true,
        firmId: true,
        role: true,
        status: true,
        profileId: true,
        previousPlan: true,
      },
    })
    if (!membership || membership.firmId !== firm.id) {
      throw new NotFoundException('Membro não encontrado')
    }
    if (membership.role === 'owner') {
      throw new BadRequestException('O dono não pode sair do próprio escritório.')
    }
    await this.releaseMember(membership)
    await this.syncSeats(firm.id)
    return this.manageView(firm.id)
  }

  // Desfaz o vínculo devolvendo o plano individual. Um membro ATIVO usava o tier do
  // escritório; sem devolver, sair viraria um rebaixamento silencioso para free.
  //
  // A devolução passa pela porta que RECONCILIA (ProfilesService), não por um
  // `profile.update` cru. Enquanto foi cru, quem saía de um escritório voltava ao
  // Free carregando o tema do Max e o botão de agendar ligados: o perfil público
  // seguia prometendo o que o plano não entregava, até um próximo save do editor
  // que podia nunca vir.
  private async releaseMember(m: {
    id: string
    status: string
    profileId: string
    previousPlan: string | null
  }) {
    if (m.status === 'active') {
      const volta = (m.previousPlan as Plan) ?? 'free'
      await this.profiles.aplicarAssinaturaPorPerfil(
        m.profileId,
        // Plano individual de volta, sem herdar o relógio de cobrança do
        // escritório: quem paga o escritório é o dono dele, não este advogado.
        { plan: volta, planStatus: 'active', currentPeriodEnd: null, graceUntil: null, planScheduled: null },
        `saída do escritório: ${volta}`,
      )
    }
    await this.prisma.firmMembership.delete({ where: { id: m.id } })
  }

  // ---- Lado de quem foi convidado ------------------------------------------

  // Convites pendentes dirigidos ao usuário logado (o que o painel dele mostra).
  async myInvites(userId: string) {
    const memberships = await this.prisma.firmMembership.findMany({
      where: { status: 'invited', profile: { userId } },
      select: {
        id: true,
        role: true,
        firm: { select: { name: true, slug: true, city: true, state: true } },
      },
    })
    return memberships.map((m) => ({
      id: m.id,
      role: m.role,
      firm: { name: m.firm.name, slug: m.firm.slug, city: m.firm.city, state: m.firm.state },
    }))
  }

  private async requireOwnInvite(userId: string, membershipId: string) {
    const m = await this.prisma.firmMembership.findUnique({
      where: { id: membershipId },
      select: {
        id: true,
        status: true,
        previousPlan: true,
        profileId: true,
        firmId: true,
        profile: { select: { userId: true, plan: true } },
        firm: { select: { id: true, plan: true } },
      },
    })
    if (!m) throw new NotFoundException('Convite não encontrado')
    if (m.profile.userId !== userId) throw new ForbiddenException('Esse convite não é seu')
    return m
  }

  // Aceitar: o vínculo vira ativo e o advogado passa a usar o tier do escritório.
  // O plano individual dele fica guardado para a volta (previousPlan).
  async acceptInvite(userId: string, membershipId: string) {
    const m = await this.requireOwnInvite(userId, membershipId)
    if (m.status === 'active') return { status: 'active' as const }
    await this.prisma.firmMembership.update({
      where: { id: m.id },
      data: { status: 'active', previousPlan: m.profile.plan },
    })
    // Mesma porta do checkout e do webhook: entrar no escritório é uma SUBIDA de
    // plano, e subir de plano também reconcilia o endereço (o número automático do
    // Free cai fora). Antes, o `profile.update` cru pulava essa parte e o membro
    // ficava com o endereço numerado dentro de um escritório que paga o tier alto.
    await this.profiles.aplicarAssinaturaPorPerfil(
      m.profileId,
      // O escritório não tem prazo por advogado — quem tem período pago é o dono.
      { plan: m.firm.plan as Plan, planStatus: 'active', currentPeriodEnd: null, graceUntil: null, planScheduled: null },
      `entrada no escritório: ${m.firm.plan}`,
    )

    // O advogado entrou de verdade: o Profile dele assume o lugar no grid, e a
    // linha que o escritório havia listado à mão sai — senão o mesmo advogado
    // apareceria DUAS vezes na página, uma com perfil e outra sem.
    //
    // A limpeza é aqui, no aceite, e não no cadastro: entre criar a conta e
    // aceitar, a pessoa ainda pode recusar, e até lá a listagem do escritório
    // continua sendo a única coisa que a página tem para mostrar.
    const conta = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    })
    if (conta?.email) {
      await this.prisma.firmRosterLawyer
        .deleteMany({ where: { firmId: m.firmId, email: conta.email } })
        .catch(() => undefined)
      await this.syncSeats(m.firmId)
    }
    return { status: 'active' as const }
  }

  // Recusar: some o vínculo, o perfil segue exatamente como estava.
  async declineInvite(userId: string, membershipId: string) {
    const m = await this.requireOwnInvite(userId, membershipId)
    await this.releaseMember({
      id: m.id,
      status: m.status,
      profileId: m.profileId,
      previousPlan: m.previousPlan,
    })
    await this.syncSeats(m.firmId)
    return { status: 'declined' as const }
  }

  // Sair por vontade própria (o membro, não o dono). Mesmo caminho de releaseMember.
  async leave(userId: string) {
    const m = await this.prisma.firmMembership.findFirst({
      where: { profile: { userId } },
      select: {
        id: true,
        firmId: true,
        role: true,
        status: true,
        profileId: true,
        previousPlan: true,
      },
    })
    if (!m) throw new NotFoundException('Você não faz parte de um escritório')
    if (m.role === 'owner') {
      throw new BadRequestException('O dono não pode sair do próprio escritório.')
    }
    await this.releaseMember(m)
    await this.syncSeats(m.firmId)
    return { status: 'left' as const }
  }

  // ---- Shape público --------------------------------------------------------

  private toApi(firm: any) {
    // Advogados ativos → shape do card/mini-perfil. Área exibida = 1ª área do perfil.
    // Perfil sem nome (rascunho recém-criado) não vai ao ar como card vazio.
    const lawyers = firm.members
      .filter((m: any) => (m.profile?.name ?? '').trim())
      .map((m: any) => {
        const p = m.profile
        const linkedin = (p.socials ?? []).find((s: any) => s.kind === 'linkedin')?.url
        return {
          id: p.id,
          slug: p.slug,
          name: p.name,
          oabNumber: p.oabNumber,
          area: p.areas?.[0]?.label ?? '',
          bio: p.bio ?? '',
          avatarUrl: p.avatarUrl ?? undefined,
          linkedin,
          // Só serve ao encaminhamento do assistente (assistantRoute: 'lawyer');
          // o card do grid não mostra o número de ninguém.
          whatsapp: p.whatsapp ?? undefined,
        }
      })
      // Advogados LISTADOS pelo escritório, que ainda não têm conta. Entram na
      // mesma lista e na mesma ordenação alfabética: para quem visita, são
      // advogados da sociedade como os outros — o que muda é só o que a página
      // consegue mostrar deles.
      //
      // `slug` vazio é o que diz ao card para não virar link: não há perfil para
      // onde ir, e um card clicável que leva a lugar nenhum é pior do que um card
      // que não convida ao clique.
      .concat(
        (firm.roster ?? [])
          .filter((r: any) => (r.name ?? '').trim())
          .map((r: any) => ({
            id: r.id,
            slug: '',
            name: r.name,
            oabNumber: r.oabNumber ?? '',
            area: r.area ?? '',
            bio: '',
            avatarUrl: undefined,
            linkedin: undefined,
            // Sem WhatsApp: o assistente nunca encaminha para quem não tem conta,
            // porque não há número dele aqui — cai no institucional, como já faz
            // quando o advogado escolhido não tem número.
            whatsapp: undefined,
          })),
      )
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
      monogram: firm.monogram,
      logoUrl: firm.logoUrl ?? undefined,
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
      assistantRoute: firm.assistantRoute ?? 'institutional',
      areas,
      lawyers,
      // Metadados de plano/assentos (usados por área administrativa; inócuos ao público).
      seats: { purchased: firm.seatsPurchased, used: lawyers.length },
      monthlyPrice: firmMonthlyPrice(Math.max(firm.seatsPurchased, lawyers.length)),
    }
  }
}
