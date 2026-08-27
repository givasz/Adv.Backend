import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { faixa, pagina } from '../admin/paginacao'
import { degrau, exigeIdentificacao, venceEm } from '../admin/sancoes'
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
  /** Por quantos dias a medida vale. Ausente = o padrão do degrau. */
  dias?: unknown
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

    // Ninguém tem o próprio nome retirado do ar por reclamação de quem não se
    // identifica. Dizer que a inscrição é falsa, ou que o perfil se passa por
    // outra pessoa, é acusação sobre QUEM A PESSOA É — e o acusador precisa ter
    // rosto. Nos demais motivos o anonimato continua valendo, de propósito: quem
    // denuncia captação irregular de um colega não deve precisar se expor numa
    // profissão pequena e competitiva. Ver admin/sancoes.ts.
    if (exigeIdentificacao(input.reason) && !email) {
      throw new BadRequestException(
        'Para denunciar registro falso ou perfil se passando por outra pessoa, informe seu e-mail. ' +
          'Acusação sobre a identidade de alguém não é aceita de forma anônima.',
      )
    }

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

  /**
   * A fila, agrupada por perfil.
   *
   * Antes esta consulta trazia **toda denúncia já feita** para agrupar em
   * memória — sem `take` nenhum. Funcionava com dezenas e não funcionaria com
   * dezenas de milhares, e o painel nunca dizia quantos perfis havia na fila.
   *
   * A paginação é por PERFIL, não por denúncia: um perfil com quarenta denúncias
   * é uma linha da fila, não quarenta. Por isso a consulta é em duas etapas —
   * primeiro quais perfis entram nesta página, depois as denúncias deles.
   */
  async listReports(
    status: 'open' | 'resolved' | 'dismissed' | 'all' = 'open',
    limite?: unknown,
    offset?: unknown,
  ) {
    const where = status === 'all' ? {} : { status }
    const { take, skip } = faixa(limite, offset)

    // 1. Quais perfis, e em que ordem (o da denúncia mais recente na frente).
    const grupos = await this.prisma.report.groupBy({
      by: ['profileId'],
      where,
      _max: { createdAt: true },
      orderBy: { _max: { createdAt: 'desc' } },
      take,
      skip,
    })
    // Quantos perfis existem na fila inteira — é o número que a tela mostra.
    const total = await this.prisma.profile.count({ where: { reports: { some: where } } })

    if (!grupos.length) return pagina([], total, take, skip)

    const ids = grupos.map((g) => g.profileId)
    // 2. As denúncias desses perfis. Todas as do perfil, inclusive as já
    //    resolvidas quando o filtro é "abertas": o histórico dele é o que
    //    permite ver reincidência antes de decidir.
    const reports = await this.prisma.report.findMany({
      where: { profileId: { in: ids } },
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

    const porPerfil = new Map<string, { profile: (typeof reports)[number]['profile']; reports: any[] }>()
    for (const r of reports) {
      if (!porPerfil.has(r.profileId)) porPerfil.set(r.profileId, { profile: r.profile, reports: [] })
      const { profile: _omit, ...resto } = r
      porPerfil.get(r.profileId)!.reports.push(resto)
    }

    // A ordem quem manda é a do groupBy — o Map veio da segunda consulta.
    const itens = ids
      .map((id) => porPerfil.get(id))
      .filter(Boolean)
      .map((g) => ({
        profile: g!.profile,
        reports: g!.reports,
        openCount: g!.reports.filter((r) => r.status === 'open').length,
        total: g!.reports.length,
      }))

    return pagina(itens, total, take, skip)
  }

  /** Detalhe completo do perfil + todas as suas denúncias (para o admin avaliar). */
  async getProfileForModeration(profileId: string) {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      include: {
        areas: { orderBy: { order: 'asc' } },
        faqs: { orderBy: { order: 'asc' } },
        socials: true,
        reports: { orderBy: { createdAt: 'desc' } },
      },
    })
    if (!profile) throw new NotFoundException('Perfil não encontrado')
    return profile
  }

  /**
   * O estado de moderação de um perfil, antes de mexer nele.
   *
   * Serve ao registro do painel: sem o "antes", o histórico diz que alguém
   * restringiu um perfil, mas não diz se ele já estava restrito — e a diferença
   * entre uma decisão nova e a repetição de uma antiga é justamente o que se
   * quer ler meses depois. Perfil inexistente devolve null em vez de lançar: a
   * rota seguinte é que decide o 404.
   */
  async estadoDeModeracao(profileId: string) {
    return this.prisma.profile.findUnique({
      where: { id: profileId },
      select: {
        moderationStatus: true,
        moderationUntil: true,
        billingPausedAt: true,
        hiddenSections: true,
        published: true,
        slug: true,
      },
    })
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
      select: { id: true, bio: true, plan: true, billingPausedAt: true },
    })
    if (!profile) throw new NotFoundException('Perfil não encontrado')
    const perfilPago = profile.plan !== 'free'

    const status = ACTION_TO_STATUS[action]
    const hiddenSections =
      action === 'partial' ? JSON.stringify(input.hiddenSections) : '[]'

    // Prazo. Uma medida sem prazo não é sanção, é esquecimento: a restrição fica
    // de pé para sempre porque ninguém voltou na fila para desfazê-la.
    const ate = action === 'clear' ? null : venceEm(action, input.dias)

    // Cobrança. Serviço pago e indisponível não pode seguir sendo cobrado —
    // é indefensável perante o CDC mesmo quando a restrição é justa. Só a
    // restrição do perfil inteiro derruba o serviço; aviso e ocultação parcial
    // deixam a página no ar. Ver docs/politica-de-sancoes.md § 2.3.
    const pausaCobranca = !!degrau(action)?.suspendeCobranca && perfilPago
    const billingPausedAt =
      action === 'clear' ? null : pausaCobranca ? new Date() : profile.billingPausedAt

    await this.prisma.profile.update({
      where: { id: profileId },
      data: {
        moderationStatus: status,
        moderationNote: action === 'clear' ? '' : note,
        moderationUntil: ate,
        billingPausedAt,
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
