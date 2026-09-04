import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { planoVigente } from '../assinatura'
import { aceiteVigente } from '../legal/termos'

// OS NÚMEROS DA PLATAFORMA — o que existe hoje e como chegou aqui.
//
// Duas fontes, e a diferença entre elas é o ponto deste arquivo:
//
//   AGORA  → as tabelas vivas (Profile, User, Firm). Respondem "quantos são".
//   SÉRIE  → BiPerfilDia, o retrato diário. Responde "quantos eram".
//
// Não dá para trocar uma pela outra. `Profile` guarda ESTADO e é sobrescrito a
// cada mudança: perguntar a ele quantos Pro havia em junho não é difícil, é
// impossível. É exatamente por isso que a rotina de BI existe (ver
// bi/bi.service.ts) — e é por isso que a série só começa no dia em que ela subiu.
//
// ---------------------------------------------------------------------------
// DUAS REGRAS QUE NÃO SE NEGOCIAM AQUI
//
// 1. O SQL NUNCA DECIDE PLANO. Quem diz qual plano vale é `planoVigente()`, em
//    TypeScript, cruzando o contratado com a situação da cobrança e as datas.
//    Reescrever aquela escada de datas numa cláusula SQL criaria uma segunda
//    resposta para a mesma pergunta — e as duas divergem no primeiro ajuste de
//    carência, sem ninguém perceber qual delas está errada. Na série o problema
//    não existe: `BiPerfilDia.planoVigente` já foi calculado assim no dia.
//
// 2. BURACO NÃO SE PREENCHE. Se a rotina não rodou num dia, aquele dia não vem
//    na resposta e `cobertura.buracos` o denuncia. Copiar o valor do dia
//    anterior deixaria o gráfico bonito e mentiroso — e um gráfico que interpola
//    ausência é a forma mais convincente de mentir.

/** Um dia da série, já pivotado por plano. */
export interface DiaDaSerie {
  dia: string
  free: number
  pro: number
  premium: number
  publicados: number
}

const PLANOS = ['free', 'pro', 'premium'] as const

/** Limites do recorte pedido pela tela. 90 dias é o padrão; 730 é o teto. */
function janelaDeDias(bruto: unknown): number {
  const n = Number(bruto)
  if (!Number.isFinite(n)) return 90
  return Math.min(730, Math.max(7, Math.trunc(n)))
}

function diaISO(d: Date): string {
  return d.toISOString().slice(0, 10)
}

@Injectable()
export class LevantamentosService {
  constructor(private readonly prisma: PrismaService) {}

  async levantar(diasBrutos?: unknown) {
    const dias = janelaDeDias(diasBrutos)
    const desde = new Date()
    desde.setUTCHours(0, 0, 0, 0)
    desde.setUTCDate(desde.getUTCDate() - dias)

    const [agora, serie, novasContas, eventosMes, porUf] = await Promise.all([
      this.agora(),
      this.serie(desde),
      this.novasContas(desde),
      this.eventosPorMes(),
      this.porUf(),
    ])

    return { dias, agora, serie, novasContas, eventosMes, porUf, cobertura: cobertura(serie) }
  }

  /**
   * O retrato de hoje, direto das tabelas vivas.
   *
   * Traz o perfil inteiro do que `planoVigente` precisa e decide em memória. São
   * dezenas ou centenas de linhas, não milhões: a agregação em SQL economizaria
   * nada e custaria a única coisa que importa, que é ter UMA definição de plano.
   */
  private async agora() {
    const [perfis, contas, escritorios, usuarios] = await Promise.all([
      this.prisma.profile.findMany({
        select: {
          plan: true,
          planStatus: true,
          currentPeriodEnd: true,
          graceUntil: true,
          published: true,
          moderationStatus: true,
          state: true,
        },
      }),
      this.prisma.user.count(),
      this.prisma.firm.count(),
      this.prisma.user.findMany({ select: { termsVersion: true } }),
    ])

    const porPlano: Record<string, number> = { free: 0, pro: 0, premium: 0 }
    const porCobranca: Record<string, number> = {}
    const porModeracao: Record<string, number> = {}
    let publicados = 0

    for (const p of perfis) {
      porPlano[planoVigente(p as any)] += 1
      porCobranca[p.planStatus] = (porCobranca[p.planStatus] ?? 0) + 1
      porModeracao[p.moderationStatus] = (porModeracao[p.moderationStatus] ?? 0) + 1
      if (p.published) publicados += 1
    }

    // Contratado x vigente: a diferença é gente com assinatura vencida ainda
    // usando o que pagou. Some da soma por plano e some do faturamento — e é a
    // única forma de ver as duas coisas ao mesmo tempo.
    const contratadoPago = perfis.filter((p) => p.plan !== 'free').length
    const vigentePago = porPlano.pro + porPlano.premium

    const aceitePendente = usuarios.filter((u) => !aceiteVigente(u.termsVersion)).length

    return {
      contas,
      perfis: perfis.length,
      publicados,
      rascunhos: perfis.length - publicados,
      escritorios,
      porPlano,
      porCobranca,
      porModeracao,
      // Quantos estão de pé só pela carência/período residual.
      emCortesia: contratadoPago - vigentePago,
      aceitePendente,
      aceiteEmDia: contas - aceitePendente,
    }
  }

  /**
   * A série diária, pivotada por plano.
   *
   * `groupBy` e não SQL cru: o pivô é de três colunas conhecidas e cabe em
   * memória com folga (um dia x três planos). SQL cru aqui só acrescentaria uma
   * string para manter viva.
   */
  private async serie(desde: Date): Promise<DiaDaSerie[]> {
    const linhas = await this.prisma.biPerfilDia.groupBy({
      by: ['dia', 'planoVigente', 'publicado'],
      where: { dia: { gte: desde } },
      _count: { _all: true },
      orderBy: { dia: 'asc' },
    })

    const porDia = new Map<string, DiaDaSerie>()
    for (const l of linhas) {
      const chave = diaISO(l.dia)
      const atual =
        porDia.get(chave) ?? { dia: chave, free: 0, pro: 0, premium: 0, publicados: 0 }
      const n = l._count._all
      // Um plano fora dos três conhecidos (renomeado no futuro, lixo antigo) não
      // pode sumir em silêncio nem derrubar a soma: entra no que existe ou é
      // ignorado explicitamente, nunca gravado numa chave inventada.
      if ((PLANOS as readonly string[]).includes(l.planoVigente)) {
        atual[l.planoVigente as (typeof PLANOS)[number]] += n
      }
      if (l.publicado) atual.publicados += n
      porDia.set(chave, atual)
    }
    return [...porDia.values()].sort((a, b) => a.dia.localeCompare(b.dia))
  }

  /**
   * Contas novas por semana (segunda a domingo, hora de Brasília aproximada por
   * UTC-3 no truncamento).
   *
   * Por SEMANA e não por dia: com o volume de hoje, um gráfico diário seria uma
   * fileira de zeros com três picos de 1 — que não mostra tendência nenhuma e
   * ainda sugere que a plataforma está parada nos dias vazios.
   */
  private async novasContas(desde: Date) {
    const contas = await this.prisma.user.findMany({
      where: { createdAt: { gte: desde } },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    })
    const porSemana = new Map<string, number>()
    for (const c of contas) {
      const d = new Date(c.createdAt)
      d.setUTCHours(0, 0, 0, 0)
      // Volta para a segunda-feira da semana.
      const diaDaSemana = (d.getUTCDay() + 6) % 7
      d.setUTCDate(d.getUTCDate() - diaDaSemana)
      const chave = diaISO(d)
      porSemana.set(chave, (porSemana.get(chave) ?? 0) + 1)
    }
    return [...porSemana.entries()]
      .map(([semana, total]) => ({ semana, total }))
      .sort((a, b) => a.semana.localeCompare(b.semana))
  }

  /** Uso mensal agregado — sobrevive ao expurgo de LinkEvent. */
  private async eventosPorMes() {
    const linhas = await this.prisma.biEventoMes.groupBy({
      by: ['mes', 'evento'],
      _sum: { total: true },
      orderBy: { mes: 'asc' },
    })
    const porMes = new Map<string, { mes: string; eventos: Record<string, number> }>()
    for (const l of linhas) {
      const chave = diaISO(l.mes)
      const atual = porMes.get(chave) ?? { mes: chave, eventos: {} }
      atual.eventos[l.evento] = (atual.eventos[l.evento] ?? 0) + (l._sum.total ?? 0)
      porMes.set(chave, atual)
    }
    return [...porMes.values()].sort((a, b) => a.mes.localeCompare(b.mes))
  }

  /**
   * Onde estão os perfis. Só os PUBLICADOS: um rascunho sem UF preenchida
   * entraria como "sem UF" e inventaria uma concentração que não existe.
   */
  private async porUf() {
    const linhas = await this.prisma.profile.groupBy({
      by: ['state'],
      where: { published: true },
      _count: { _all: true },
      orderBy: { _count: { state: 'desc' } },
      take: 12,
    })
    return linhas
      .map((l) => ({ uf: l.state || '—', total: l._count._all }))
      .filter((l) => l.total > 0)
  }
}

/**
 * O que a série NÃO cobre.
 *
 * Vai para a tela junto do gráfico, e não escondido num log. A rotina de BI
 * começou num dia; antes dele não há retrato, e nenhum gráfico deveria sugerir
 * que a plataforma não existia. E, se o processo ficou fora, ficam buracos — que
 * a linha do gráfico não pode fingir que não existem.
 */
export function cobertura(serie: DiaDaSerie[]) {
  if (!serie.length) return { desde: null, ate: null, dias: 0, buracos: [] as string[] }
  const desde = serie[0].dia
  const ate = serie[serie.length - 1].dia
  const presentes = new Set(serie.map((d) => d.dia))
  const buracos: string[] = []
  const cursor = new Date(`${desde}T00:00:00Z`)
  const fim = new Date(`${ate}T00:00:00Z`)
  while (cursor < fim) {
    cursor.setUTCDate(cursor.getUTCDate() + 1)
    const chave = diaISO(cursor)
    if (!presentes.has(chave) && cursor < fim) buracos.push(chave)
  }
  return { desde, ate, dias: serie.length, buracos }
}
