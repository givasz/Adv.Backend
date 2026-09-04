import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { createHash } from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service'
import { perfilVisivelAoPublico, secoesCensuradas } from './visibilidade'
import { areaComMaisDeUma, perguntaComMaisDeUma } from '../campo-unico'
import { faixa, pagina } from '../admin/paginacao'
import { blockingFields, POLICY_VERSION, publicStatus, RULESET_REV } from '../oab/compliance'
import {
  AREA_LIMIT,
  canUseFaq,
  canUsePrintCard,
  CARD_TAGLINE_MAX,
  CARD_TEMPLATES,
  FAQ_ANSWER_MAX,
  FAQ_LIMIT,
  FAQ_QUESTION_MAX,
  canUseScheduling,
  countLimit,
  limitsFor,
  NAME_MAX,
  resolveTheme,
  OAB_MAX,
  slugify,
  type LimitedField,
  type Plan,
} from '../plans'
import {
  canUseVideo,
  normalizeVideoUrl,
  VIDEO_CAPTION_MAX,
  VIDEO_ORIENTATIONS,
} from '../video'
import {
  aoPerderOPlano,
  aoTrocarPlano,
  ehRebaixamento,
  emCortesia,
  enderecoVenceu,
  planoVigente,
  valeAte,
  type PatchAssinatura,
} from '../assinatura'
import {
  clampList,
  clampOrNull,
  clampText,
  enderecoCols,
  enderecoDaLinha,
  oneOf,
  safeEmail,
  safeHexColor,
  safeHostname,
  safeImageSrc,
  safeWhatsapp,
  safeUrl,
} from '../security/sanitize'

const relations = {
  areas: { orderBy: { order: 'asc' as const } },
  faqs: { orderBy: { order: 'asc' as const } },
  // As redes só tinham ficado de fora. Sem `orderBy`, o Postgres devolve na ordem
  // que lhe convém — e o sintoma era discreto o bastante para passar despercebido
  // por muito tempo: a fileira de ícones do perfil trocava de posição sozinha
  // entre uma visita e outra, sem ninguém ter mexido em nada.
  socials: { orderBy: { order: 'asc' as const } },
}

// Planos aceitos na troca de assinatura (POST /profiles/me/plan).
const PLANS: Plan[] = ['free', 'pro', 'premium']

// Redes aceitas — ESPELHA socialMeta em frontend/src/components/ui/icons.tsx.
// Allowlist, não blocklist: um `kind` desconhecido não tem ícone do outro lado e
// derruba a página pública inteira ao tentar renderizar.
const SOCIAL_KINDS = ['instagram', 'linkedin', 'website', 'facebook', 'youtube', 'tiktok'] as const

/** Tamanho dos textos JÁ GRAVADOS — ver enforceCharLimits (teto só para o que cresce). */
interface TextoAtual {
  headline: number
  bio: number
  /** rótulo da área → tamanho da descrição gravada */
  areaDesc: Map<string, number>
  /**
   * Os rótulos de área que JÁ estão no banco, e as perguntas do FAQ com o
   * tamanho da resposta gravada.
   *
   * Servem à mesma regra do resto deste bloco: um teto (ou uma trava de forma)
   * vale para o texto que ENTRA, nunca para o que já está lá. Quem caiu de plano
   * tem rótulo de 40 caracteres e resposta de 220 gravados; cobrá-los no próximo
   * save travaria o editor inteiro por causa de um campo que a pessoa nem tocou —
   * exatamente o defeito que enforceCharLimits foi escrito para não repetir.
   */
  areaLabels: Set<string>
  faqAnswer: Map<string, number>
}

/**
 * A JANELA DA COTA: as linhas filhas que o plano vigente entrega.
 *
 * É `order < limite`, e não "as `limite` primeiras". A diferença aparece quando
 * alguém rebaixa e depois apaga uma das linhas visíveis: com "as primeiras", uma
 * linha CONGELADA (herdada do plano maior) subiria para ocupar a vaga e apareceria
 * do nada na tela. Com a janela por posição, o que está fora dela fica fora dela
 * até o plano crescer de novo.
 *
 * O `slice` no fim é só teto de sanidade — `order` não é único no banco.
 */
function dentroDaCota<T extends { order?: number | null }>(lista: T[], limite: number): T[] {
  if (limite <= 0) return []
  return lista.filter((x) => (x.order ?? 0) < limite).slice(0, limite)
}

/**
 * O que o save precisa saber da linha ANTES de gravar por cima dela.
 *
 * Um único `select`, usado tanto no caminho normal quanto no de recuperação
 * (garantirPerfil): quando os dois divergiam, o segundo devolvia um objeto sem
 * `slug` e sem os textos, e o save seguia adiante com `undefined` no lugar de
 * dados — sem erro, só com decisões erradas.
 */
const perfilBase = {
  id: true,
  moderationStatus: true,
  plan: true,
  oabNumber: true,
  slug: true,
  // Situação da cobrança: quem decide o que está liberado é o plano VIGENTE.
  planStatus: true,
  currentPeriodEnd: true,
  graceUntil: true,
  // Tamanho dos textos já gravados — o teto de caracteres só vale para o que
  // cresce (ver enforceCharLimits).
  headline: true,
  bio: true,
  areas: { select: { label: true, description: true } },
  faqs: { select: { question: true, answer: true } },
} as const

/** Tamanhos já gravados, no formato que o enforceCharLimits espera. */
function textoAtual(p: any): TextoAtual {
  const areaDesc = new Map<string, number>()
  for (const a of p?.areas ?? []) {
    const label = String(a?.label ?? '')
    // Rótulos repetidos: fica o MAIOR. Errar para o lado permissivo aqui custa um
    // texto longo a mais; errar para o outro trava o editor de novo.
    areaDesc.set(label, Math.max(areaDesc.get(label) ?? 0, String(a?.description ?? '').length))
  }
  const faqAnswer = new Map<string, number>()
  for (const f of p?.faqs ?? []) {
    const q = String(f?.question ?? '')
    faqAnswer.set(q, Math.max(faqAnswer.get(q) ?? 0, String(f?.answer ?? '').length))
  }
  return {
    headline: String(p?.headline ?? '').length,
    bio: String(p?.bio ?? '').length,
    areaDesc,
    areaLabels: new Set<string>((p?.areas ?? []).map((a: any) => String(a?.label ?? ''))),
    faqAnswer,
  }
}

// Tetos fixos de sanidade (não dependem do plano).
const CITY_MAX = 80
const STATE_MAX = 40
const REGION_MAX = 200
// Teto de SANIDADE do rótulo (anti-abuso). O teto por PLANO é outro e vive em
// plans.ts — este aqui é só o limite acima do qual nada é razoável, inclusive
// para texto herdado de um plano maior.
const AREA_LABEL_SANIDADE = 60
const BRAND_NAME_MAX = 60
const SOCIAL_MAX = 8

@Injectable()
export class ProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * A regra de "este perfil aparece para o público" — FONTE ÚNICA, agora em
   * profiles/visibilidade.ts.
   *
   * Saiu daqui porque a QUARTA porta que devolve perfil ao público mora em outro
   * serviço (a página do escritório, em firms/), e um método privado não a
   * alcançava — então ela não filtrava nada. Ver o cabeçalho daquele arquivo.
   */
  private visivelAoPublico() {
    return perfilVisivelAoPublico()
  }

  /**
   * `contarVisita` vem do controller, que é quem conhece o IP: a gravação da
   * visita tem teto por IP (auditoria de 03/09) — sem ele, um laço de terminal
   * inflava "Quem visita você" de qualquer perfil, de graça, para sempre. O teto
   * NUNCA bloqueia a página: estourou, a visita só não é contada.
   */
  async getBySlug(slug: string, contarVisita = true) {
    const profile = await this.prisma.profile.findFirst({
      where: { slug, ...this.visivelAoPublico() },
      include: relations,
    })
    if (!profile) throw new NotFoundException('Perfil não encontrado')
    // A visita entra pela MESMA porta de todo acontecimento do perfil (o clique
    // no WhatsApp, o agendamento, a rede social) — ver analytics/eventos.ts.
    // Não esperamos por ela: a página não fica devendo à métrica.
    //
    // ⚠️ O `.catch()` NÃO é só higiene — é o que faz a consulta ACONTECER.
    //
    // Esta linha era `void this.prisma.linkEvent.create(...)` e não gravava nada.
    // `PrismaPromise` é preguiçoso: ele só dispara quando alguém chama `.then()`,
    // `.catch()` ou o aguarda. É de propósito — é isso que permite passar um
    // array de consultas ainda não executadas para `$transaction([...])`. O
    // `void` descarta a promessa sem nunca tocá-la, então a consulta jamais saía
    // daqui.
    //
    // Foi a causa real de "a tela Quem visita você mostra 0 para todo mundo".
    // A investigação parava antes: a coluna `Profile.views` também não era
    // incrementada, o que explicava o zero — mas mesmo depois de trocar a leitura
    // para LinkEvent o número continuava zero, porque não havia UMA linha de
    // visita no banco. Desde sempre. O mesmo zero silencioso aparecia na
    // exportação LGPD, que conta esta tabela (account.service.ts).
    if (contarVisita) {
      this.prisma.linkEvent
        .create({ data: { profileId: profile.id, kind: 'view' } })
        .catch(() => undefined)
    }
    const publico = this.toPublic(profile)
    const out = this.toApi(publico)
    // A foto do VISITANTE sai como ENDEREÇO (…/avatar?v=hash), não como o data
    // URI. Dentro do JSON ela pesava +33% (base64), não entrava em cache nenhum
    // e chegava antes do resto do perfil poder pintar; como endereço, o
    // navegador a busca em paralelo, o cache vale entre visitas, e o `v` (hash
    // da própria foto) troca a URL no dia em que a foto mudar — nunca antes.
    // Só aqui: o DONO (getMine/update) continua recebendo o data URI, que é o
    // que o editor recorta e o cartão de visita desenha.
    out.avatarUrl = avatarPublico(profile.slug, (publico as { avatarUrl?: string | null }).avatarUrl)
    return out
  }

  /**
   * GET /api/profiles/:slug/avatar — a foto como IMAGEM de verdade.
   *
   * Existe por causa da prévia do link. A foto é gravada como data URI
   * (`data:image/png;base64,…` — ver security/sanitize.ts, safeImageSrc), e data
   * URI não serve para `og:image`: WhatsApp, LinkedIn e Telegram buscam a imagem
   * por HTTP, num processo que nem abre a página. Enquanto a única forma da foto
   * era o data URI, todo perfil compartilhado saía sem rosto.
   *
   * Devolve os bytes decodificados com o tipo certo — e SÓ isso.
   *
   * ---------------------------------------------------------------------------
   * POR QUE ESTA ROTA NÃO REDIRECIONA MAIS (auditoria de 01/09/2026)
   *
   * Ela devolvia `{ kind: 'redirect' }` quando a foto era uma URL https (o outro
   * formato que o saneamento aceita, para quem prefere hospedar a imagem fora).
   * O controller respondia `302` para o endereço gravado.
   *
   * Isso era um REDIRECIONAMENTO ABERTO na nossa origem. Criar conta é grátis:
   * bastava salvar `avatarUrl: "https://site-do-golpe/…"`, publicar o perfil, e
   * `advoc.me/api/profiles/<slug>/avatar` passava a levar a qualquer lugar. O
   * link para mandar à vítima é do domínio da plataforma — que é exatamente o que
   * um filtro de e-mail, um antivírus e a própria pessoa olham antes de clicar.
   * De quebra, todo visitante da prévia entregava IP e User-Agent a um terceiro
   * que ele não escolheu, com a nossa origem servindo de intermediária.
   *
   * A correção não é buscar a imagem por conta própria (isso seria trocar um
   * redirecionamento aberto por um proxy de saída, com SSRF junto). É reconhecer
   * que a rota nunca precisou desse caso: quando a foto JÁ é uma URL https
   * pública, ela já é buscável pelo robô do mensageiro, e o `og:image` aponta
   * direto para ela (ver frontend/src/lib/ogTags.ts, ogImageUrl). Não há nada que
   * a nossa origem no meio acrescente — só o que ela empresta.
   *
   * Sobra o caso que é de verdade nosso: os bytes que só existem no nosso banco.
   * ---------------------------------------------------------------------------
   *
   * Não incrementa visita: quem carrega a prévia é o robô do mensageiro, não uma
   * pessoa. Contar isso inflaria a métrica do advogado com robô.
   */
  async avatarBySlug(
    slug: string,
  ): Promise<{ bytes: Buffer; contentType: string; versao: string }> {
    const profile = await this.prisma.profile.findFirst({
      where: { slug, ...this.visivelAoPublico() },
      // As colunas de moderação vêm junto: a censura parcial que esconde a foto
      // no JSON público (toPublic) tem de valer AQUI também — sem isto, a foto
      // "escondida" continuava servida a quem soubesse o endereço da rota.
      select: {
        avatarUrl: true,
        moderationStatus: true,
        moderationUntil: true,
        hiddenSections: true,
      },
    })
    if (!profile) throw new NotFoundException('Sem foto')
    const publico = this.toPublic(profile)
    const src = (publico as { avatarUrl?: string | null }).avatarUrl
    if (!src) throw new NotFoundException('Sem foto')

    const m = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(src)
    // Foto hospedada fora: 404 aqui de propósito. Quem a serve é o host dela, e
    // o og:image aponta para lá — esta rota só entrega o que é nosso.
    if (!m) throw new NotFoundException('Sem foto')

    const contentType = m[1] === 'image/jpg' ? 'image/jpeg' : m[1]
    // `versao` é o mesmo hash do `?v=` que o getBySlug põe na URL — o controller
    // usa como ETag, e um navegador que já tem a foto revalida com um 304 vazio.
    return { bytes: Buffer.from(m[2], 'base64'), contentType, versao: versaoDaFoto(src) }
  }

  /**
   * GET /api/sitemap — os endereços que o Google pode indexar.
   *
   * Deliberadamente magro: só `slug` e a data da última alteração. O `/directory`
   * existente não serve para isto — ele corta em 40 linhas e traz `avatarUrl`,
   * que é o data URI da foto inteira. Um mapa do site com 40 fotos embutidas
   * seria alguns megabytes para entregar uma lista de endereços.
   */
  async sitemap() {
    const rows = await this.prisma.profile.findMany({
      where: this.visivelAoPublico(),
      orderBy: [{ updatedAt: 'desc' }],
      take: 5000,
      select: { slug: true, updatedAt: true },
    })
    return rows.map((r) => ({ slug: r.slug, updatedAt: r.updatedAt.toISOString() }))
  }

  // Aplica a censura parcial (moderationStatus == partial) e remove os campos
  // internos de moderação antes de devolver o perfil ao público.
  private toPublic<
    T extends {
      moderationStatus: string
      moderationUntil?: Date | null
      hiddenSections: string
      avatarUrl?: string | null
      headline?: string
      bio?: string
      regionNote?: string | null
      areas?: { id: string }[]
      socials?: unknown[]
      /** o interruptor "Mostrar o endereço no perfil" — ver semEnderecoEscondido */
      addressPublic?: boolean | null
    },
  >(profile: T) {
    // Campos do DONO saem aqui: a nota do moderador é conversa entre a plataforma
    // e o advogado — nunca vai ao visitante.
    const { hiddenSections, moderationNote, moderationStatus, ...cru } = profile as T & {
      moderationNote?: string
    }
    const rest = semEnderecoEscondido(cru)
    // Censura parcial vencida devolve as seções sozinha, pelo mesmo motivo.
    if (moderationStatus !== 'partial') return rest
    const ate = (profile as { moderationUntil?: Date | null }).moderationUntil
    if (ate && ate.getTime() <= Date.now()) return rest

    // A lista de seções escondidas vem da MESMA função que as outras portas
    // públicas usam (visibilidade.ts) — duas implementações já divergiram uma
    // vez, e foi assim que a censura valeu numa porta e não na outra.
    const set = secoesCensuradas(profile)
    // Sinaliza ao público que há censura (sem revelar o quê nem a nota do admin).
    const out: any = { ...rest, contentModerated: true }
    if (set.has('avatar')) out.avatarUrl = null
    if (set.has('headline')) out.headline = ''
    if (set.has('bio')) out.bio = ''
    if (set.has('regionNote')) out.regionNote = null
    if (set.has('faqs')) out.faqs = []
    if (set.has('video')) {
      out.videoUrl = null
      out.videoCaption = ''
      out.videoOrientation = 'auto'
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
      // Só `true` liga. Qualquer outra coisa (ausente, string, número) desliga:
      // um elemento que segue o visitante pela página não pode nascer de um
      // corpo malformado — ligar é ato deliberado do advogado.
      assistantFloating: a?.floating === true,
    }
  }

  // Colunas planas → objeto `assistant` do frontend.
  //
  // `plano` entra aqui por causa do balão flutuante, que é perk de plano pago: a
  // trava vale na LEITURA, como a do vídeo e a do FAQ. Entre o dia em que a
  // assinatura vence e a passagem da varredura que reconcilia o banco existe uma
  // janela — se a leitura não fechasse a porta, o perfil seguiria com o balão
  // dentro dela.
  private buildAssistant(p: any, plano: Plan) {
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
      floating: canUseScheduling(plano) && p.assistantFloating === true,
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
  // (A promessa desta linha era falsa até 28/08/2026: o save zerava as colunas.
  // Ver o bloco `branding` em update().)
  private buildBranding(p: any, plano: Plan) {
    if (plano !== 'premium') return undefined
    const b: Record<string, unknown> = {}
    if (p.brandName) b.brandName = p.brandName
    if (p.brandAccent) b.accent = p.brandAccent
    if (p.brandHideWatermark) b.hideWatermark = true
    if (p.customDomain) b.customDomain = p.customDomain
    return Object.keys(b).length ? b : undefined
  }

  // Cartão de visita → uma coluna de JSON, saneada campo a campo. Aceitar o
  // objeto do cliente cru deixaria entrar chave desconhecida e string gigante numa
  // coluna que ninguém mais valida.
  private cardCol(c: any): string {
    if (!c || typeof c !== 'object') return ''
    const bool = (v: unknown, dflt: boolean) => (typeof v === 'boolean' ? v : dflt)
    const template = oneOf(c.template, CARD_TEMPLATES, 'timbre')
    return JSON.stringify({
      template,
      showPhoto: bool(c.showPhoto, false),
      showQr: bool(c.showQr, true),
      showWhatsapp: bool(c.showWhatsapp, true),
      showEmail: bool(c.showEmail, true),
      showCity: bool(c.showCity, true),
      showAddress: bool(c.showAddress, true),
      showAreas: bool(c.showAreas, true),
      tagline: clampText(c.tagline, CARD_TAGLINE_MAX),
    })
  }

  // Coluna → objeto `card` do frontend. JSON inválido vira "sem cartão montado":
  // o editor cai no padrão em vez de quebrar a tela.
  private buildCard(p: any, plano: Plan) {
    if (!canUsePrintCard(plano) || !p.card) return undefined
    try {
      const parsed = JSON.parse(p.card)
      return parsed && typeof parsed === 'object' ? parsed : undefined
    } catch {
      return undefined
    }
  }

  // Mapeia a linha (plana) do Prisma para o shape ANINHADO esperado pelo frontend
  // (serviceMode/contact/branding + coleções filhas). Ver frontend/src/lib/types.ts.
  // Usado nos retornos públicos (getBySlug/getMine/update); a moderação tem shape
  // próprio (ModerationProfile) e NÃO passa por aqui.
  //
  // O `plan` DEVOLVIDO É O VIGENTE, não o contratado (ver src/assinatura.ts). Todo
  // portão do produto — front e back — lê este campo, então é ele que precisa
  // dizer a verdade sobre o que está liberado AGORA. O que a pessoa contratou, e
  // por que está ou não valendo, vai à parte, em `subscription`, e só para o dono:
  // é conversa entre a plataforma e o advogado, não informação de visitante.
  private toApi(p: any) {
    const plano = planoVigente(p)
    const out: any = {
      slug: p.slug,
      name: p.name,
      oabNumber: p.oabNumber,
      headline: p.headline ?? '',
      bio: p.bio ?? '',
      avatarUrl: p.avatarUrl ?? undefined,
      city: p.city ?? '',
      state: p.state ?? '',
      // Endereço vai INTEIRO para o dono e para o público. O interruptor
      // `publico` viaja junto porque quem esconde o endereço tem de continuar
      // vendo o que escondeu — e quem decide não desenhar é a página
      // (enderecoVisivel, em lib/endereco.ts), não a censura da resposta: o
      // cartão de contato que o próprio visitante salva usa o mesmo objeto.
      address: enderecoDaLinha(p),
      regionNote: p.regionNote ?? undefined,
      serviceMode: { inPerson: !!p.inPerson, online: !!p.online },
      // Áreas e FAQ são CORTADAS no limite do plano vigente, e cortadas aqui — na
      // leitura. Quem rebaixa continua com tudo no banco e volta a ver tudo no dia
      // em que reassinar; o que o plano menor não entrega apenas para de aparecer.
      // Antes o corte era no SAVE, o que apagava as linhas excedentes de vez.
      areas: dentroDaCota(p.areas ?? [], countLimit(AREA_LIMIT, plano)).map((a: any) => ({
        id: a.id,
        label: a.label,
        description: a.description,
      })),
      // Vídeo é perk do Max: fora dele some da resposta, mas a coluna continua no
      // banco — quem rebaixa e volta reencontra o link (mesma regra do branding).
      videoUrl: canUseVideo(plano) ? (p.videoUrl ?? undefined) : undefined,
      videoCaption: canUseVideo(plano) ? p.videoCaption || undefined : undefined,
      videoOrientation: canUseVideo(plano) ? (p.videoOrientation ?? undefined) : undefined,
      // Perguntas frequentes: recurso pago. Fora dos planos pagos some da resposta,
      // mas as linhas continuam no banco — quem rebaixa e volta reencontra o texto
      // (mesma regra do vídeo e do branding).
      faqs: canUseFaq(plano)
        ? dentroDaCota(p.faqs ?? [], countLimit(FAQ_LIMIT, plano)).map((f: any) => ({
            id: f.id,
            question: f.question,
            answer: f.answer,
          }))
        : [],
      socials: (p.socials ?? []).map((s: any) => ({ kind: s.kind, url: s.url })),
      contact: {
        whatsapp: p.whatsapp ?? undefined,
        email: p.email ?? undefined,
        scheduling: p.scheduling ?? undefined,
      },
      // Agendamento e tema também passam pelo plano VIGENTE na leitura, e não só
      // no save. Entre o dia em que a assinatura vence e a passagem da varredura
      // que reconcilia o banco existe uma janela — se a leitura não fechasse a
      // porta, o perfil público seguiria com botão de agendar e tema do Max dentro
      // dela. É o mesmo motivo pelo qual a moderação também vence na leitura.
      schedulingMode: this.sanitizeMode(p.schedulingMode, plano),
      booking: {
        weekdays: this.parseWeekdays(p.bookingWeekdays),
        startMin: p.bookingStartMin ?? 540,
        endMin: p.bookingEndMin ?? 1080,
        slotMin: p.bookingSlotMin ?? 30,
        leadHours: p.bookingLeadHours ?? 12,
        horizonDays: p.bookingHorizonDays ?? 30,
      },
      assistant: this.buildAssistant(p, plano),
      plan: plano,
      theme: resolveTheme(p.theme, plano),
      published: p.published,
      policyRevChecked: p.policyRevChecked,
      branding: this.buildBranding(p, plano),
      card: this.buildCard(p, plano),
    }
    // Campos do dono (getMine) — ausentes no público (toPublic os remove).
    if (p.moderationStatus !== undefined) {
      out.moderationStatus = p.moderationStatus
      // Estado da assinatura — SÓ para o dono. O visitante não tem nada a ver com
      // a situação de cobrança de quem ele está lendo, e um "pagamento atrasado"
      // vazando para a página pública seria constrangimento gratuito.
      out.subscription = this.buildSubscription(p, plano)
    }
    if (p.moderationNote) out.moderationNote = p.moderationNote
    if (p.contentModerated) out.contentModerated = true
    return out
  }

  /**
   * O que o painel precisa saber sobre a assinatura para dizer a verdade ao dono.
   *
   * `plan` (acima) é o que vale agora; aqui vai o que foi CONTRATADO e por que
   * ainda vale — ou por que parou de valer. Sem isto o painel só saberia dizer
   * "você está no Free", que é exatamente a mentira a evitar com quem pagou o Max
   * e teve o cartão recusado ontem.
   */
  private buildSubscription(p: any, vigente: Plan) {
    const contratado = (p.plan as Plan) ?? 'free'
    const ate = valeAte(p)
    return {
      plan: contratado,
      status: (p.planStatus as string) ?? 'active',
      /** true quando o acesso pago só está de pé por carência/mês já pago */
      cortesia: emCortesia(p),
      /** o vigente já é rebaixado em relação ao contratado? */
      rebaixado: contratado !== 'free' && vigente !== contratado,
      validoAte: ate ? ate.toISOString() : null,
      currentPeriodEnd: p.currentPeriodEnd ? new Date(p.currentPeriodEnd).toISOString() : null,
      graceUntil: p.graceUntil ? new Date(p.graceUntil).toISOString() : null,
      /** rebaixamento pedido, esperando o fim do período pago */
      planScheduled: (p.planScheduled as Plan) ?? null,
      /**
       * Até quando o endereço limpo ainda é desta pessoa depois de ela cair para o
       * Free. É o que o painel usa para avisar com data, antes de a varredura
       * carimbar o número — a única forma de a troca não ser uma emboscada.
       */
      slugGraceUntil: p.slugGraceUntil ? new Date(p.slugGraceUntil).toISOString() : null,
    }
  }

  async getMine(userId: string) {
    const p = await this.prisma.profile.findUnique({ where: { userId }, include: relations })
    return p ? this.toApi(p) : null
  }

  /**
   * Garante que a conta tem uma linha de perfil.
   *
   * O cadastro já cria uma (ver auth.service), mas contas anteriores a essa
   * regra — e qualquer linha perdida numa migração — chegavam aqui sem perfil, e
   * o `profile.update` estourava um erro interno do Prisma. Do lado de quem usa,
   * isso era um "não foi possível salvar" que nunca passava, por mais que
   * tentasse: o editor não tinha o que consertar.
   */
  private async garantirPerfil(userId: string, nome?: string) {
    const base = slugify(nome || 'advogado')
    // Duas tentativas bastam: o sufixo é aleatório em 9 mil valores e a corrida
    // é entre duas abas da MESMA pessoa. Se ainda assim colidir, o erro sobe.
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      try {
        return await this.prisma.profile.create({
          data: {
            userId,
            slug: `${base}-${Math.floor(1000 + Math.random() * 9000)}`,
            name: nome ?? '',
            oabNumber: '',
            plan: 'free',
            published: false,
            policyVersion: POLICY_VERSION,
          },
          select: perfilBase,
        })
      } catch (err) {
        // Outra aba criou o perfil no meio do caminho: use o que existe.
        const existente = await this.prisma.profile.findUnique({
          where: { userId },
          select: perfilBase,
        })
        if (existente) return existente
        if (tentativa === 2) throw err
      }
    }
    throw new NotFoundException('Perfil não encontrado')
  }

  /**
   * O que um perfil PÚBLICO não pode deixar de ter.
   *
   * Não existia checagem nenhuma: dava para publicar sem nome e sem número de
   * OAB. O perfil ia ao ar com o endereço `perfil-4821`, o cabeçalho vazio e o
   * link do CNA apontando para uma consulta sem nome — e ninguém era avisado de
   * nada, porque a requisição respondia 200. O advogado descobria sozinho, se
   * descobrisse, abrindo o próprio link.
   *
   * Os dois campos não são escolha de produto: o perfil É publicidade da
   * advocacia, e ela tem de identificar quem anuncia. Sem o número da OAB o
   * `CnaLink` (a consulta à base oficial, que é o que substitui um selo de
   * verificação) não tem o que consultar. Ver REGRAS.md.
   *
   * A mensagem lista TUDO que falta de uma vez, e nomeia os campos como eles
   * aparecem na tela. Recusar um campo por vez faria a pessoa descobrir o
   * segundo problema só depois de resolver o primeiro.
   */
  private exigirCamposDePublicacao(data: any) {
    const faltando: string[] = []
    if (!String(data.name ?? '').trim()) faltando.push('seu nome')
    if (!String(data.oabNumber ?? '').trim()) faltando.push('seu número da OAB')

    if (faltando.length === 0) return
    throw new BadRequestException(
      `Para publicar, falta preencher: ${faltando.join(' e ')}. ` +
        'Seu rascunho continua salvo — complete e publique de novo.',
    )
  }

  /**
   * Valida os limites de caracteres do plano (fonte da verdade). Lança 400 se
   * exceder. O `plan` vem SEMPRE do banco (assinatura vigente) — nunca do corpo.
   *
   * O TETO VALE PARA O TEXTO QUE CRESCE, não para o que já estava escrito.
   *
   * Sem esta distinção, um rebaixamento TRAVAVA o editor: quem tinha mil
   * caracteres de bio no Max e caía para o Free (300) recebia 400 em qualquer save
   * — inclusive num save que só trocava o telefone — e não conseguia mexer em nada
   * até cortar setecentos caracteres à mão, sem que nada na tela explicasse o
   * porquê. Enquanto isso o perfil público seguia exibindo os mil.
   *
   * Agora o texto herdado pode ficar e pode ENCURTAR; o que não pode é aumentar.
   * O plano continua vendendo "escrever mais" — só parou de sequestrar o editor de
   * quem já escreveu.
   *
   * E não truncamos o texto na leitura pública: cortar bio de advogado no meio de
   * uma frase muda o que ela diz, e o que ela diz é publicidade sujeita ao
   * Prov. 205/2021. Um teto de EDIÇÃO não vira mordaça de exibição.
   */
  private enforceCharLimits(data: any, plan: Plan, atual?: TextoAtual) {
    // Tetos fixos (não dependem do plano) — sanidade/anti-abuso.
    if (data.name && data.name.length > NAME_MAX) {
      throw new BadRequestException(`O nome excede o limite de ${NAME_MAX} caracteres.`)
    }
    if (data.oabNumber && data.oabNumber.length > OAB_MAX) {
      throw new BadRequestException(`O número da OAB excede o limite de ${OAB_MAX} caracteres.`)
    }

    const lim = limitsFor(plan)
    const check = (
      value: string | undefined,
      field: LimitedField,
      label: string,
      herdado: number,
    ) => {
      const tam = value?.length ?? 0
      if (tam <= lim[field]) return
      // Já era assim (ou maior) antes deste save: é texto herdado de um plano
      // maior, e o save não é o momento de cobrá-lo.
      if (tam <= herdado) return
      throw new BadRequestException(
        `${label} excede o limite de ${lim[field]} caracteres do plano ${plan}.`,
      )
    }
    check(data.headline, 'headline', 'A frase de apresentação', atual?.headline ?? 0)
    check(data.bio, 'bio', 'A bio', atual?.bio ?? 0)
    for (const a of data.areas ?? []) {
      // A área é casada pelo RÓTULO, não pela posição: o editor reordena e remove
      // áreas, e comparar por índice acusaria "aumentou" numa área que só mudou de
      // lugar. Área nova (rótulo desconhecido) responde pelo teto do plano — é
      // exatamente o texto que está crescendo.
      const herdado = atual?.areaDesc?.get(String(a.label ?? '')) ?? 0
      check(a.description, 'areaDesc', `A descrição da área "${a.label}"`, herdado)
    }
  }

  /**
   * UM ASSUNTO POR CAMPO — a trava que impede a cota de ser burlada por dentro.
   *
   * O Free entrega uma área e uma pergunta. Sem esta conferência, quem quer três
   * áreas escreve "Família, Sucessões e Inventários" no rótulo único e quem quer
   * três perguntas empilha as três numa: a cota fica intacta no banco e furada na
   * tela. A regra em si mora em src/campo-unico.ts, espelhada no editor —
   * conferir só no cliente seria pedir por favor.
   *
   * Vale para o texto que ENTRA. Rótulo e pergunta que JÁ estão gravados passam:
   * quem escreveu "Cível / Criminal" antes desta trava existir não pode descobrir
   * isso ao tentar trocar o telefone, com o save inteiro recusado por um campo
   * que ele não tocou. É a mesma regra do teto de caracteres, pelo mesmo motivo.
   */
  private enforceCampoUnico(data: any, atual?: TextoAtual) {
    for (const a of data.areas ?? []) {
      const label = String(a?.label ?? '')
      if (atual?.areaLabels?.has(label)) continue
      const problema = areaComMaisDeUma(label)
      if (problema) {
        throw new BadRequestException(`${problema.motivo} Sugestão: "${problema.sugestao}".`)
      }
    }
    for (const f of data.faqs ?? []) {
      const question = String(f?.question ?? '')
      if (atual?.faqAnswer?.has(question)) continue
      const problema = perguntaComMaisDeUma(question)
      if (problema) {
        throw new BadRequestException(`${problema.motivo} Sugestão: "${problema.sugestao}".`)
      }
    }
  }

  // Perguntas frequentes → linhas prontas para o Prisma, cortadas na COTA do plano
  // (nenhuma no Free, 2 no Pro, 5 no Max).
  //
  // O corte aqui é só do que ENTRA. O que já existe além da cota não passa por
  // esta função e não é tocado pelo save — ver o bloco `faqs` em update(). Até
  // 28/08/2026 era o contrário: o `deleteMany` limpava a tabela e esta função
  // devolvia lista vazia no Free, então o primeiro save depois de um rebaixamento
  // apagava as perguntas de vez. O comentário que estava aqui prometia justamente
  // o oposto ("o downgrade apenas ESCONDE"), e a promessa era falsa.
  //
  // Uma pergunta SEM resposta não vai para o perfil: caixa vazia com uma dúvida
  // pendurada é pior do que não ter FAQ nenhum.
  private faqRows(raw: unknown, max: number, plan: Plan, atual?: TextoAtual) {
    if (max <= 0) return []
    const perguntaMax = countLimit(FAQ_QUESTION_MAX, plan)
    const respostaMax = countLimit(FAQ_ANSWER_MAX, plan)
    const list = Array.isArray(raw) ? raw : []
    return list
      .filter(
        (f: any) =>
          typeof f?.question === 'string' &&
          f.question.trim() &&
          typeof f?.answer === 'string' &&
          f.answer.trim(),
      )
      .slice(0, max)
      .map((f: any, order: number) => {
        const question = String(f.question).trim()
        // Os tetos de TEXTO viraram tabela por plano em 04/09/2026, e o Free é o
        // mais curto. Cortar pelo teto do plano ATUAL apagaria, em silêncio e no
        // primeiro save, pedaço de resposta escrita no Max por quem acabou de cair
        // para o Free. Então o corte respeita o que já está gravado: a pergunta
        // conhecida passa inteira, e a resposta dela também.
        const conhecida = atual?.faqAnswer?.has(question) ?? false
        const herdado = atual?.faqAnswer?.get(question) ?? 0
        return {
          question: conhecida ? question : question.slice(0, perguntaMax),
          answer: String(f.answer).trim().slice(0, Math.max(respostaMax, herdado)),
          order,
        }
      })
  }

  private randomSuffix(): number {
    return Math.floor(1000 + Math.random() * 9000) // 4 dígitos
  }

  /**
   * O endereço parece ser o "nome-1234" que a plataforma impõe no Free?
   *
   * Serve para NÃO mexer duas vezes na mesma pessoa: quem já está numerado não
   * tem endereço limpo a perder, e portanto não abre prazo nenhum ao descer.
   *
   * O critério é o mesmo do `stripAutoNumber` em resolveSlug, e erra sempre para o
   * lado de não tocar: um "joao-silva-2020" escolhido à mão pelo advogado casa o
   * padrão e é tratado como automático — o efeito é ele MANTER o endereço, que é
   * o erro barato dos dois.
   */
  private pareceAutoNumerado(slug: string, name: string): boolean {
    const base = slugify(name ?? '')
    if (!base) return false
    return new RegExp(`^${base}-\\d+$`).test(slug ?? '')
  }

  /**
   * Um endereço "nome-1234" livre, para carimbar quem perdeu o plano.
   *
   * `resolveSlug` não serve aqui: no ramo do Free ele PRESERVA o endereço que já
   * existe — comportamento certo para um save comum e exatamente o oposto do que
   * esta função precisa fazer.
   */
  private async slugNumerado(name: string, selfUserId: string): Promise<string> {
    const base = slugify(name ?? '') || 'advogado'
    for (let i = 0; i < 12; i++) {
      const candidato = `${base}-${this.randomSuffix()}`
      const dono = await this.prisma.profile.findUnique({
        where: { slug: candidato },
        select: { userId: true },
      })
      if (!dono || dono.userId === selfUserId) return candidato
    }
    // 12 sorteios em 9 mil valores só colidem se o nome for extraordinariamente
    // comum. O carimbo do relógio fecha a porta sem estourar a varredura.
    return `${base}-${Date.now().toString().slice(-6)}`
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
    /**
     * O endereço GRAVADO no banco. No Free ele é a única coisa que conta — o
     * `desiredSlug` vem do corpo da requisição e escolher o endereço é perk pago;
     * aceitá-lo aqui entregaria de graça o que o Pro vende.
     */
    slugAtual?: string,
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

    // Free: MANTÉM o endereço que já existe, qualquer que seja ele, desde que
    // esteja livre. Só sorteia quando não há endereço (perfil recém-criado) ou
    // quando o que havia foi tomado por outra pessoa.
    //
    // Antes, o Free só preservava o endereço quando ele batia o padrão
    // "nome-<número>" do nome VIGENTE. Duas consequências, as duas ruins:
    //
    //  • REBAIXAMENTO MATAVA O ENDEREÇO. Quem assinou o Pro ganhou
    //    advoc.me/marina-sales; no dia em que o cartão falhasse, o endereço limpo
    //    não casava o padrão do Free e um número novo era sorteado. O cartão de
    //    visita impresso, o QR, o link na assinatura de e-mail, o link no
    //    Instagram e a indexação do Google apontavam, todos, para um 404. Isso é
    //    dano, e dano que chega antes do e-mail avisando da cobrança.
    //  • CORRIGIR UM TYPO NO NOME MUDAVA O ENDEREÇO. No Free, trocar "Marina
    //    Salles" por "Marina Sales" renumerava a página inteira, sem ninguém pedir.
    //
    // O endereço público é da pessoa, não do plano. O que o Pro vende é ESCOLHER o
    // endereço (e nascer sem número); quem nasce no Free continua nascendo
    // numerado, em garantirPerfil. Nada disso se perde ao parar de renumerar.
    //
    // O candidato é o slug GRAVADO, nunca o do corpo da requisição: preservar o
    // endereço existente é uma coisa, deixar o Free escolher um é outra — e a
    // segunda é exatamente o perk que o Pro cobra.
    const current = (slugAtual || '').trim()
    if (current && !(await takenByOther(current))) return current
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

  /**
   * Fronteira de entrada do perfil. O corpo do PUT é JSON livre — tipo, tamanho e
   * formato só passam a existir aqui. O que chega errado vira valor neutro em vez
   * de derrubar a requisição; o que chega grande demais é cortado.
   *
   * Os links merecem nota: `href` com `javascript:` é execução de script na página
   * pública do advogado, com acesso à sessão de quem estiver visitando. Por isso
   * todo link passa por safeUrl (só http/https) — na gravação, e não só na tela.
   */
  private sanitizeInput(data: any) {
    const d = data && typeof data === 'object' ? data : {}
    const c = d.contact && typeof d.contact === 'object' ? d.contact : {}
    const b = d.branding && typeof d.branding === 'object' ? d.branding : {}

    return {
      ...d,
      name: clampText(d.name, NAME_MAX),
      oabNumber: clampText(d.oabNumber, OAB_MAX),
      // headline/bio mantêm o texto inteiro: o teto por plano é conferido depois
      // (enforceCharLimits), que devolve um erro explicando o limite em vez de
      // cortar o texto da pessoa em silêncio.
      headline: clampText(d.headline, 4000),
      bio: clampText(d.bio, 8000),
      avatarUrl: safeImageSrc(d.avatarUrl),
      city: clampText(d.city, CITY_MAX),
      state: clampText(d.state, STATE_MAX),
      // Já sai como as seis colunas planas do Prisma — o update só espalha.
      addressCols: enderecoCols(d.address),
      regionNote: clampOrNull(d.regionNote, REGION_MAX),
      serviceMode: {
        inPerson: !!d.serviceMode?.inPerson,
        online: !!d.serviceMode?.online,
      },
      areas: clampList<any>(d.areas, 40).map((a: any) => ({
        label: clampText(a?.label, AREA_LABEL_SANIDADE),
        description: clampText(a?.description, 4000),
      })),
      faqs: clampList<any>(d.faqs, 20),
      socials: clampList<any>(d.socials, SOCIAL_MAX)
        .map((s: any) => ({
          kind: oneOf(s?.kind, SOCIAL_KINDS, 'website'),
          url: safeUrl(s?.url),
        }))
        // Link recusado (esquema estranho, texto solto) some da lista em vez de
        // virar um <a> quebrado — ou pior, executável — na página pública.
        .filter((s) => !!s.url)
        // A ORDEM da lista é a ordem em que o advogado arrastou no editor, e é o
        // índice que a grava. Vem depois do filtro de propósito: um link recusado
        // no meio da lista deixaria um buraco na numeração se contasse antes.
        .map((s, order) => ({ kind: s.kind as string, url: s.url as string, order })),
      contact: {
        whatsapp: safeWhatsapp(c.whatsapp),
        email: safeEmail(c.email),
        scheduling: safeUrl(c.scheduling),
      },
      videoUrl: typeof d.videoUrl === 'string' ? d.videoUrl : null,
      videoCaption: clampText(d.videoCaption, VIDEO_CAPTION_MAX),
      videoOrientation: oneOf(d.videoOrientation, VIDEO_ORIENTATIONS, 'auto'),
      published: !!d.published,
      branding: {
        brandName: clampOrNull(b.brandName, BRAND_NAME_MAX),
        // Cor livre viraria CSS injetado no tema do perfil — só hexadecimal entra.
        accent: safeHexColor(b.accent),
        hideWatermark: !!b.hideWatermark,
        customDomain: safeHostname(b.customDomain),
      },
    }
  }

  async update(userId: string, raw: any) {
    // Nada abaixo desta linha vê o corpo cru: tipo, tamanho e formato de link são
    // decididos aqui, antes da checagem de conformidade e do banco.
    const data = this.sanitizeInput(raw)
    // O PLANO É DO SERVIDOR: vem da assinatura gravada no banco, nunca do corpo da
    // requisição. Antes, um `plan: "premium"` no JSON liberava limites e recursos —
    // e, do outro lado, a assinatura simulada não sobrevivia ao recarregar a página
    // (o update não gravava o plano). A troca de plano agora tem porta própria:
    // POST /api/profiles/me/plan → setPlan().
    const current =
      (await this.prisma.profile.findUnique({
        where: { userId },
        select: perfilBase,
      })) ?? (await this.garantirPerfil(userId, data.name))
    // Perfil restrito pela moderação não pode ser republicado pelo dono.
    if (data.published && current?.moderationStatus === 'restricted') {
      throw new ForbiddenException(
        'Este perfil foi restringido pela moderação e não pode ser publicado. Fale com o suporte para revisão.',
      )
    }
    // O que um perfil PÚBLICO não pode deixar de ter.
    if (data.published) this.exigirCamposDePublicacao(data)

    // O plano que vale AGORA — contratado cruzado com a situação da cobrança. É
    // ele, e não `Profile.plan`, que abre e fecha recurso (ver src/assinatura.ts).
    const plan: Plan = planoVigente(current as any)
    // O que já está gravado — os tetos e as travas de forma valem para o texto que
    // ENTRA, nunca para o que a pessoa herdou de um plano maior.
    const atual = textoAtual(current)
    // Fonte da verdade dos limites por plano.
    this.enforceCharLimits(data, plan, atual)
    this.enforceCampoUnico(data, atual)
    // O endereço candidato no Free é o GRAVADO, nunca o do corpo (perk pago).
    const slug = await this.resolveSlug(
      data.name,
      plan,
      data.slug,
      userId,
      false,
      (current as any)?.slug,
    )

    // Fonte da verdade da conformidade: bloqueia publicação com texto irregular.
    // A lista do que é conferido vive em oab/compliance.ts (publicTexts) e cobre
    // TUDO que o visitante lê — frase de apresentação, bio, áreas (nome e
    // descrição), FAQ, legenda do vídeo, abertura do assistente e o nome no rodapé.
    // Um texto irregular escondido atrás de uma pergunta, ou na linha logo abaixo
    // do nome, é publicidade irregular do mesmo jeito.
    const worstStatus = publicStatus(data)

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
      // Dizer QUAL campo travou: com a checagem cobrindo o perfil inteiro, um erro
      // genérico obrigaria o advogado a caçar o trecho no escuro.
      const campos = blockingFields(data)
      throw new BadRequestException(
        campos.length
          ? `Há termos vedados pelas normas de publicidade da OAB em: ${campos.join(', ')}. Ajuste antes de publicar.`
          : 'O texto contém termos que violam as normas de publicidade da OAB. Ajuste antes de publicar.',
      )
    }

    // Cota das coleções filhas neste plano. Fora dela nada é lido nem tocado.
    const limiteAreas = countLimit(AREA_LIMIT, plan)
    const limiteFaqs = countLimit(FAQ_LIMIT, plan)

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
        ...data.addressCols,
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
        // Vídeo é perk do Max, e fora dele a chave NEM ENTRA no update: a coluna
        // fica como estava. Até 28/08/2026 esta linha gravava `null` fora do Max —
        // então bastava um save qualquer depois de um rebaixamento (trocar o
        // telefone servia) para o link do vídeo sumir do banco, contra a promessa
        // escrita duas telas acima, em toApi. Dentro do Max, link de provedor não
        // aceito continua limpando o campo, em vez de persistir lixo.
        ...(canUseVideo(plan)
          ? {
              videoUrl: normalizeVideoUrl(data.videoUrl),
              videoCaption: String(data.videoCaption ?? '').slice(0, VIDEO_CAPTION_MAX),
              videoOrientation: data.videoOrientation,
            }
          : {}),
        published: data.published,
        policyVersion: POLICY_VERSION,
        // Carimba a revisão vigente das regras (monitor normativo): ao salvar, o
        // perfil passa a estar "em dia" com o RULESET_REV atual.
        policyRevChecked: RULESET_REV,
        // Cartão impresso é perk do Max. Fora dele a chave nem entra no update: a
        // coluna fica como estava, e quem rebaixa e volta reencontra o cartão
        // montado (mesma regra do branding).
        ...(canUsePrintCard(plan) ? { card: this.cardCol(data.card) } : {}),
        // Identidade própria (white-label) — perk do Max, mesma regra do vídeo e do
        // cartão impresso: fora dele a chave não entra e as colunas ficam intactas.
        //
        // Este era o mais traiçoeiro dos três apagamentos. Fora do Max, buildBranding
        // omite o objeto inteiro da resposta; o editor devolvia o perfil SEM
        // `branding`, e estas quatro linhas liam `undefined` e gravavam `null`. Ou
        // seja: quem rebaixava perdia a marca no primeiro save, sem ter tocado em
        // nada relacionado a ela.
        ...(plan === 'premium'
          ? {
              brandName: data.branding?.brandName ?? null,
              brandAccent: data.branding?.accent ?? null,
              brandHideWatermark: data.branding?.hideWatermark ?? false,
              customDomain: data.branding?.customDomain ?? null,
            }
          : {}),
        // Coleções filhas: o save substitui apenas o que está DENTRO da cota do
        // plano (`order < limite`). O que está além — herdado de um plano maior —
        // não é lido, não é reescrito e não é apagado; fica congelado esperando o
        // plano voltar. Ver dentroDaCota, que é a mesma janela do lado da leitura.
        //
        // Era `deleteMany: {}`: limpava a tabela inteira e recriava só o que cabia
        // no plano atual. Um Max com 20 áreas e 5 perguntas que caísse para o Free
        // perdia 18 áreas e as 5 perguntas no primeiro save — e no Free
        // `faqRows` devolvia lista vazia, então o `deleteMany` era a operação
        // inteira: apagava tudo e não criava nada.
        areas: {
          deleteMany: { order: { lt: limiteAreas } },
          create: (data.areas ?? [])
            .slice(0, limiteAreas)
            .map((a: any, order: number) => ({
              label: a.label,
              description: a.description,
              order,
            })),
        },
        faqs: {
          deleteMany: { order: { lt: limiteFaqs } },
          create: this.faqRows(data.faqs, limiteFaqs, plan, atual),
        },
        socials: {
          deleteMany: {},
          create: (data.socials ?? []).map((s: any) => ({
            kind: s.kind,
            url: s.url,
            order: s.order ?? 0,
          })),
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
   * Troca o plano PEDIDA PELA PESSOA (checkout do front, hoje sem cobrança real).
   *
   * SUBIR vale na hora. DESCER é AGENDADO para o fim do período já pago — cobrar
   * um mês de Max e entregar Pro no dia seguinte é vender o que não se entrega.
   * Quem decide qual dos dois é o caso é aoTrocarPlano(), em src/assinatura.ts; o
   * rebaixamento agendado fica em `planScheduled` e a varredura diária o aplica.
   *
   * Quando entrar a cobrança real, esta continua sendo a porta do USUÁRIO (ela
   * chamará o provedor para efetivar). Quem manda no estado da assinatura passa a
   * ser o webhook — src/billing/billing.service.ts —, e as duas portas gravam pelo
   * mesmo caminho: aplicarAssinatura().
   */
  async setPlan(userId: string, plan: unknown) {
    if (typeof plan !== 'string' || !PLANS.includes(plan as Plan)) {
      throw new BadRequestException('Plano inválido.')
    }
    const next = plan as Plan
    const current = await this.prisma.profile.findUnique({
      where: { userId },
      select: {
        id: true,
        plan: true,
        planStatus: true,
        currentPeriodEnd: true,
        graceUntil: true,
        planScheduled: true,
      },
    })
    if (!current) throw new NotFoundException('Perfil não encontrado')

    const patch = aoTrocarPlano(current as any, next)
    if (Object.keys(patch).length === 0) {
      const same = await this.prisma.profile.findUnique({ where: { userId }, include: relations })
      return this.toApi(same)
    }

    const updated = await this.aplicarAssinatura(userId, patch, `${current.plan} → ${next}`)
    return this.toApi(updated)
  }

  /**
   * A ÚNICA porta que grava o estado da assinatura. Toda mudança de plano passa
   * por aqui: o checkout do usuário, o webhook do provedor, a varredura diária, a
   * entrada e a saída de escritório, e a exclusão de conta do dono.
   *
   * Por que uma porta só: antes havia quatro caminhos gravando `Profile.plan` com
   * `prisma.profile.update` cru, e três deles esqueciam a reconciliação. Quem saía
   * de um escritório voltava ao Free carregando tema do Max e botão de agendar
   * ligados — o perfil público prometendo o que o plano não entrega — até o
   * próximo save do editor, que podia nunca vir.
   *
   * O que é reconciliado AQUI é só o que o público veria errado (tema e
   * agendamento). Conteúdo — vídeo, marca, cartão, perguntas, áreas além da cota —
   * NÃO é tocado: some da leitura e volta inteiro quando o plano voltar.
   *
   * O ENDEREÇO NÃO É MEXIDO AQUI no rebaixamento — nem quando ele cai para o
   * Free. Cair para o Free ABRE UM PRAZO (`slugGraceUntil`), e o endereço limpo
   * continua no ar até ele vencer; quem carimba o número é a varredura diária,
   * depois de sete dias com a data escrita no painel. A subida, essa sim, mexe no
   * endereço na hora, para entregar o perk do nome limpo.
   *
   * Por que prazo em vez de troca imediata: o endereço está impresso em cartão de
   * visita, colado num QR e indexado no Google. Trocá-lo no segundo em que o
   * cartão de crédito falha é emboscada. Nunca trocá-lo, por outro lado, é
   * regalar o perk mais visível do Pro a quem parou de pagar.
   */
  private async aplicarAssinatura(
    userId: string,
    patch: PatchAssinatura,
    motivo: string,
    agora: Date = new Date(),
  ) {
    const antes = await this.prisma.profile.findUnique({
      where: { userId },
      select: { id: true, name: true, slug: true, plan: true, schedulingMode: true, theme: true,
                planStatus: true, currentPeriodEnd: true, graceUntil: true, planScheduled: true,
                slugGraceUntil: true },
    })
    if (!antes) throw new NotFoundException('Perfil não encontrado')

    // O plano vigente ANTES e DEPOIS do patch — é a diferença entre os dois que
    // diz o que reconciliar. Note que um rebaixamento AGENDADO não muda o vigente
    // (o patch só grava `planScheduled`), e portanto não reconcilia nada: a pessoa
    // segue com o que pagou até o período virar.
    const antesVigente = planoVigente(antes as any)
    const depois = planoVigente({ ...antes, ...patch } as any)
    const subiu = ehRebaixamento(depois, antesVigente)

    const dados: Record<string, unknown> = { ...patch }
    // Agendamento é recurso pago: cair para o Free desliga o botão do perfil.
    dados.schedulingMode = this.sanitizeMode(antes.schedulingMode, depois)
    // Tema de plano superior não sobrevive ao rebaixamento — volta ao neutro.
    dados.theme = resolveTheme(antes.theme, depois)
    // Só ao SUBIR o endereço é reescrito, e só para tirar o número automático que
    // o Free impõe — que é exatamente o perk que o Pro vende.
    if (subiu) {
      dados.slug = await this.resolveSlug(antes.name, depois, antes.slug, userId, true, antes.slug)
    }

    // ---- O prazo do endereço --------------------------------------------------
    //
    // Três casos, e o silêncio do quarto importa tanto quanto os outros:
    if (depois !== 'free') {
      // 1. Está num plano pago (subiu, ou desceu de Max para Pro): não há prazo a
      //    correr. Zerar aqui é o que devolve o endereço a quem reassinou dentro
      //    da semana — sem isso, a varredura carimbaria alguém que voltou a pagar.
      dados.slugGraceUntil = null
    } else if (antesVigente !== 'free' && !this.pareceAutoNumerado(antes.slug, antes.name)) {
      // 2. Acabou de cair para o Free com endereço limpo: começa a contagem.
      dados.slugGraceUntil = aoPerderOPlano(agora)
    }
    // 3. Já era Free, ou já estava numerado: nada muda. Em especial, uma segunda
    //    passagem da varredura sobre a mesma linha NÃO reinicia o relógio — se
    //    reiniciasse, o prazo nunca venceria, que é o mesmo defeito que a carência
    //    de cobrança já teve (ver aoFalharPagamento).

    const updated = await this.prisma.profile.update({
      where: { userId },
      data: dados,
      include: relations,
    })

    // Trilha de auditoria: a mudança de assinatura altera o que o perfil exibe.
    await this.prisma.auditLog.create({
      data: {
        profileId: updated.id,
        action: 'plan',
        complianceStatus: 'ok',
        policyVersion: POLICY_VERSION,
        bioSnapshot: motivo,
      },
    })

    return updated
  }

  /**
   * Mesma porta, para quem não é o dono da conta: o webhook de cobrança, a
   * varredura diária, o escritório e a moderação. Recebe o id do PERFIL (é o que
   * essas rotas têm em mãos) e devolve o perfil já reconciliado.
   */
  async aplicarAssinaturaPorPerfil(profileId: string, patch: PatchAssinatura, motivo: string) {
    const dono = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { userId: true },
    })
    if (!dono) throw new NotFoundException('Perfil não encontrado')
    return this.aplicarAssinatura(dono.userId, patch, motivo)
  }

  /**
   * Carimba o número no endereço de quem perdeu o plano e deixou o prazo vencer.
   * Chamada só pela varredura diária (billing/assinaturas.service.ts).
   *
   * Devolve o endereço novo, ou `null` quando não havia o que fazer — a varredura
   * é idempotente e esta função é a segunda tranca: ela reconfere, na linha
   * gravada, que o plano vigente é mesmo o Free. Quem voltou a pagar entre a
   * consulta e a escrita sai daqui intocado.
   *
   * O endereço ANTIGO não é redirecionado: ele volta a ficar livre, e prendê-lo a
   * um redirecionamento seria continuar entregando ao Free o perk que o Pro vende.
   * É por isso que o aviso existe, e é por isso que ele tem uma semana.
   */
  async carimbarEnderecoVencido(profileId: string, agora: Date = new Date()) {
    const p = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { id: true, name: true, slug: true, userId: true, plan: true, planStatus: true,
                currentPeriodEnd: true, graceUntil: true, planScheduled: true, slugGraceUntil: true },
    })
    if (!p) return null

    if (!enderecoVenceu(p as any, agora)) {
      // Prazo apagado, plano de volta, ou ainda no prazo. Se o prazo continua
      // marcado mas a pessoa está pagando, limpa a sujeira e sai.
      if (p.slugGraceUntil && planoVigente(p as any, agora) !== 'free') {
        await this.prisma.profile.update({
          where: { id: p.id },
          data: { slugGraceUntil: null },
        })
      }
      return null
    }

    // Já numerado (por um save que sorteou outro endereço no meio da semana, por
    // exemplo): não há o que carimbar, só o prazo a encerrar.
    if (this.pareceAutoNumerado(p.slug, p.name)) {
      await this.prisma.profile.update({ where: { id: p.id }, data: { slugGraceUntil: null } })
      return null
    }

    const anterior = p.slug
    const novo = await this.slugNumerado(p.name, p.userId)
    await this.prisma.profile.update({
      where: { id: p.id },
      data: { slug: novo, slugGraceUntil: null },
    })

    // O endereço é a coisa mais pública do perfil: a troca vai para a trilha, com
    // o de antes e o de agora. É o registro que responde "por que meu QR parou de
    // funcionar" sem depender da memória de ninguém.
    await this.prisma.auditLog.create({
      data: {
        profileId: p.id,
        action: 'plan',
        complianceStatus: 'ok',
        policyVersion: POLICY_VERSION,
        bioSnapshot: `endereço devolvido ao padrão do Free: ${anterior} → ${novo}`,
      },
    })

    return { anterior, novo }
  }

  // A plataforma NÃO confere inscrições na OAB. O número é auto-declarado e o
  // perfil público expõe, ao lado dele, um link para a consulta do CNA (base
  // oficial), igual para todos os planos — ver frontend components/ui/CnaLink.
  // Registro falso é tratado pela moderação (denúncia com motivo `oab_invalid`).

  // Busca do PAINEL ADMIN: ao contrário do diretório público, retorna perfis de
  // qualquer status (não publicados, restritos etc.) para o moderador localizar e agir.
  /**
   * Busca do painel. Antes devolvia 50 e calava sobre o resto: quem procurasse
   * um nome comum via meia lista sem nada dizendo que havia mais.
   */
  async adminSearch(q?: string, limite?: unknown, offset?: unknown) {
    const query = (q ?? '').trim()
    const { take, skip } = faixa(limite, offset)
    const where = query
      ? {
          OR: [
            { name: { contains: query } },
            { slug: { contains: query } },
            { oabNumber: { contains: query } },
            { city: { contains: query } },
          ],
        }
      : {}

    // Uma ida ao banco só: a contagem e a fatia saem da mesma transação, senão
    // o total podia descrever uma lista diferente da que foi devolvida.
    const [itens, total] = await this.prisma.$transaction([
      this.prisma.profile.findMany({
        where,
        // O nome não é único: sem o desempate por id, duas pessoas homônimas
        // podem trocar de lugar entre uma página e a seguinte, e uma delas
        // sumir da listagem.
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take,
        skip,
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
        },
      }),
      this.prisma.profile.count({ where }),
    ])
    return pagina(itens, total, take, skip)
  }

  // GET /api/directory foi REMOVIDA na auditoria de 03/09/2026.
  //
  // A rota nunca foi chamada por tela nenhuma, e a auditoria de 01/09 já tinha
  // posto a escolha por escrito: "se a decisão for que não haverá diretório
  // público, o certo é REMOVER a rota, não deixá-la de porta aberta" (A02 —
  // remover o que não se usa). Enquanto existiu, cada varredura achou algo nela:
  // primeiro os megabytes de foto embutida e a colisão de OR que desligava a
  // moderação (01/09), depois o vazamento de headline/áreas censuradas e o custo
  // de 40 hashes por requisição (03/09). Superfície pública sem uso é só isso —
  // manutenção de risco sem cliente. Se a busca nascer um dia, o git guarda a
  // última versão, e ela renasce por trás de teto por IP e do toPublic.
}

/**
 * Versão curta e estável da foto — muda quando a foto muda, e só então.
 *
 * Vai na URL (`?v=`) e no ETag da rota de avatar. É o que permite ao navegador
 * guardar a imagem como imutável: trocar a foto troca o endereço, então nenhum
 * cache precisa expirar "por via das dúvidas".
 */
function versaoDaFoto(dataUri: string): string {
  return createHash('sha256').update(dataUri).digest('hex').slice(0, 8)
}

/**
 * A foto pública — sempre um ENDEREÇO, nunca os bytes.
 *
 * O data URI vira o caminho da nossa rota de avatar (com a versão, para o cache
 * poder ser longo); a foto hospedada fora segue como está, porque já é um
 * endereço público e a nossa origem não tem o que acrescentar no meio dela.
 * Exportada porque a página do escritório (firms.service) publica a foto dos
 * membros e precisa da MESMA regra — era lá que o data URI cru ainda saía.
 */
export function avatarPublico(slug: string, avatarUrl: string | null | undefined): string | undefined {
  if (!avatarUrl) return undefined
  if (avatarUrl.startsWith('data:')) {
    return `/api/profiles/${encodeURIComponent(slug)}/avatar?v=${versaoDaFoto(avatarUrl)}`
  }
  return avatarUrl.startsWith('https://') ? avatarUrl : undefined
}

/**
 * Tira do perfil as colunas do endereço quando o advogado mandou escondê-lo.
 *
 * ---------------------------------------------------------------------------
 * ISTO ERA UM VAZAMENTO DE ENDEREÇO RESIDENCIAL (auditoria de 01/09/2026)
 *
 * O interruptor "Mostrar o endereço no perfil" existe no editor e promete, com
 * estas palavras: *"O endereço fica só com você — não aparece na página nem no
 * cartão de contato que o visitante salva."* A dica logo abaixo diz para quem
 * ele foi feito: *"Quem atende em casa costuma deixar desligado."*
 *
 * Só que quem o cumpria era a PÁGINA. A API mandava rua, número, complemento,
 * bairro e CEP para qualquer visitante, junto do interruptor, e o React é que
 * decidia não desenhar (`enderecoVisivel`, em lib/endereco.ts). Um `curl` no
 * perfil público devolvia o endereço inteiro:
 *
 *     curl https://advoc.me/api/profiles/<slug> | jq .address
 *
 * O dado exposto é, pela própria dica do editor, o endereço de CASA de um
 * advogado que pediu para escondê-lo — de uma profissão que acumula
 * desafetos por ofício. É a definição de controle de privacidade que só
 * existe no cliente, e o cliente nunca foi barreira.
 *
 * O cuidado já existia nos dois lugares DERIVADOS do endereço — o JSON-LD da
 * prévia de link e o vCard — cada um com um comentário explicando que um
 * endereço escondido não pode vazar por ali. Faltava na fonte dos dois.
 *
 * Fica em `toPublic`, e não em `toApi`, porque `toApi` serve o dono também: o
 * dono PRECISA continuar vendo o que escondeu, senão o campo se apaga sozinho
 * na tela dele. `toPublic` é a única passagem por onde só o visitante entra.
 * ---------------------------------------------------------------------------
 */
function semEnderecoEscondido<T extends { addressPublic?: boolean | null }>(p: T): T {
  if (p.addressPublic !== false) return p
  // As mesmas colunas que `enderecoCols` grava (security/sanitize.ts). Zeradas
  // todas, `enderecoDaLinha` devolve `undefined` e o campo `address` some da
  // resposta — em vez de ir vazio, que contaria que existe um endereço oculto.
  return {
    ...p,
    addressZip: null,
    addressStreet: null,
    addressNumber: null,
    addressComplement: null,
    addressDistrict: null,
  }
}
