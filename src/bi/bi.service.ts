import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { planoVigente } from '../assinatura'
import { diaLocal, janelaDoMes, mesAnterior, mesLocal, mesSeguinte } from './tempo'

// A ROTINA QUE GUARDA A HISTÓRIA — ver docs/plano-bi.md e prisma/bi/bi.sql.
//
// ---------------------------------------------------------------------------
// POR QUE ISTO NÃO PODE ESPERAR
//
// Quase todo defeito de dado dá para consertar depois: falta um índice, põe-se o
// índice; a coluna está errada, corrige-se a coluna. Este não.
//
// `Profile` guarda ESTADO: plano, situação de cobrança e UF são sobrescritos na
// própria linha a cada mudança. Ninguém guarda o que havia antes. No dia em que
// alguém perguntar "quantos Pro tínhamos em junho", a resposta não vai ser
// difícil de calcular — vai ser impossível: a informação não existe em lugar
// nenhum do banco, e não existe backup que a devolva, porque nunca foi escrita.
//
// Cada dia sem esta rotina é um dia de história que não vai existir nunca. É o
// único item do plano de BI cujo adiamento DESTRÓI informação em vez de apenas
// atrasá-la — e é por isso que ela sobe antes de haver um único gráfico pronto.
//
// ---------------------------------------------------------------------------
// AS DUAS COISAS QUE ELA FAZ
//
//  1. RETRATO DIÁRIO (BiPerfilDia) — uma linha por perfil por dia, com o plano
//     que a pessoa PODIA USAR naquele dia.
//  2. FECHAMENTO MENSAL (BiEventoMes) — visitas e cliques somados por mês, para
//     o histórico longo sobreviver ao expurgo de LinkEvent (400 dias).
//
// Mesmo padrão da retenção e da varredura de assinaturas: o próprio processo
// acorda, sem cron do sistema para alguém esquecer de instalar num servidor
// novo. E é idempotente por construção — rodar dez vezes no mesmo dia tem o
// efeito de rodar uma.
//
// ---------------------------------------------------------------------------
// O QUE ELA NÃO FAZ
//
// Não inventa dia que não rodou. Se o processo ficou três dias fora, ficam três
// buracos, e a view `bi.manutencao_snapshot` os mostra. Copiar o estado de hoje
// para trás encheria a série de dados plausíveis e falsos — e um gráfico que
// interpola ausência é a forma mais convincente de mentir.

/**
 * Por quanto tempo o retrato diário fica guardado. O dobro da janela de eventos
 * (400 dias), que é o que cobre "este mês contra o mesmo mês do ano passado" com
 * folga para a comparação ainda ter um ano anterior inteiro atrás dela.
 *
 * A LGPD pede prazo para tudo (art. 15, I), inclusive para o que é só cópia do
 * que já está no perfil. O expurgo roda aqui mesmo.
 */
export const RETENCAO_RETRATO_DIAS = 800

/**
 * Quantos meses são recalculados a cada passagem.
 *
 * O mês corrente muda o dia inteiro, então tem de ser refeito sempre. Os dois
 * anteriores entram para o caso de o processo ter ficado fora na virada — sem
 * eles, um deploy demorado no dia 1º deixaria o mês passado fechado pela metade,
 * para sempre. Três é barato (uma agregação sobre ~90 dias, uma vez por dia) e
 * cobre qualquer indisponibilidade real.
 *
 * Uma parada MAIOR que isso é coberta pelo recomeço: quando `BiEventoMes` está
 * vazia, a rotina fecha todos os meses que houver evento (ver `fecharMeses`).
 */
const MESES_A_FECHAR = 3

const INTERVALO_MS = 24 * 60 * 60 * 1000
// Um pouco depois do expurgo (5 min) e da varredura de assinaturas (2 min): as
// três acordam no mesmo boot, e disputar o banco no instante em que o pm2 está
// conferindo se o processo respondeu não ajuda nenhuma das três.
const PRIMEIRA_MS = 8 * 60 * 1000
// Perfis por lote. O retrato é uma leitura larga (todo perfil, todo dia); em
// fatias, o banco nunca vê uma transação grande.
const LOTE = 500

@Injectable()
export class BiService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('BI')
  private timer?: ReturnType<typeof setInterval>
  private primeira?: ReturnType<typeof setTimeout>

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.primeira = setTimeout(() => {
      void this.passar()
      this.timer = setInterval(() => void this.passar(), INTERVALO_MS)
      // `unref` para o temporizador não segurar o processo de pé sozinho: sem
      // isso um SIGTERM de deploy esperaria o intervalo inteiro e o pm2 mataria
      // à força.
      this.timer.unref?.()
    }, PRIMEIRA_MS)
    this.primeira.unref?.()
  }

  onModuleDestroy() {
    if (this.primeira) clearTimeout(this.primeira)
    if (this.timer) clearInterval(this.timer)
  }

  /**
   * Uma passagem completa. Pública para o `npm run bi` poder chamar à mão —
   * útil logo depois de um deploy, sem esperar o intervalo.
   *
   * Cada etapa é protegida sozinha: uma falha no fechamento mensal não pode
   * custar o retrato do dia, que é justamente o que não dá para refazer amanhã.
   */
  async passar(agora: Date = new Date()): Promise<{
    retratados: number
    meses: number
    expurgados: number
  }> {
    const retratados = await this.tentar('retrato', () => this.retratar(agora))
    const meses = await this.tentar('fechamento mensal', () => this.fecharMeses(agora))
    const expurgados = await this.tentar('expurgo do retrato', () => this.expurgar(agora))

    if (retratados || meses || expurgados) {
      this.log.log(
        `retrato: ${retratados} perfis · meses fechados: ${meses} · ` +
          `expurgo: ${expurgados} linhas (>${RETENCAO_RETRATO_DIAS}d)`,
      )
    }
    return { retratados, meses, expurgados }
  }

  /**
   * O retrato de um dia. Refazer o mesmo dia SUBSTITUI o que havia: o retrato é
   * derivado, não é registro de acontecimento, e a versão mais recente do dia é
   * sempre a mais correta.
   *
   * Percorre por cursor (e não por `skip`) porque `skip` grande faz o Postgres
   * ler e descartar tudo que veio antes — a leitura fica mais lenta a cada lote,
   * bem quando a base cresce.
   */
  async retratar(agora: Date = new Date()): Promise<number> {
    const dia = diaLocal(agora)
    let cursor: string | undefined
    let total = 0

    for (;;) {
      const perfis = await this.prisma.profile.findMany({
        select: {
          id: true,
          plan: true,
          planStatus: true,
          currentPeriodEnd: true,
          graceUntil: true,
          planScheduled: true,
          published: true,
          moderationStatus: true,
          state: true,
          firmMembership: { select: { id: true } },
        },
        orderBy: { id: 'asc' },
        take: LOTE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })
      if (perfis.length === 0) break

      const linhas = perfis.map((p) => ({
        dia,
        profileId: p.id,
        planoContratado: String(p.plan),
        // O plano VIGENTE é decidido pela mesma função que decide o que o perfil
        // entrega hoje (src/assinatura.ts). Reescrever aquela escada de datas em
        // SQL, do lado do BI, criaria uma segunda verdade — e ela divergiria no
        // primeiro ajuste de carência, sem ninguém saber qual das duas está certa.
        planoVigente: planoVigente(p, agora),
        situacaoCobranca: String(p.planStatus),
        publicado: p.published,
        moderacao: String(p.moderationStatus),
        uf: p.state ?? '',
        emEscritorio: p.firmMembership !== null,
      }))

      await this.prisma.$transaction([
        this.prisma.biPerfilDia.deleteMany({
          where: { dia, profileId: { in: perfis.map((p) => p.id) } },
        }),
        this.prisma.biPerfilDia.createMany({ data: linhas }),
      ])

      total += linhas.length
      cursor = perfis[perfis.length - 1].id
      if (perfis.length < LOTE) break
    }

    return total
  }

  /**
   * Fecha os meses recentes — e, no primeiro uso, todos os que houver.
   *
   * A ordem importa em relação ao expurgo de LinkEvent (400 dias, ver
   * retencao.service.ts): o mês precisa estar somado ANTES de o evento cru
   * sumir. Como só se fecham meses recentes, isso é automático enquanto a rotina
   * roda; o recomeço abaixo cobre o caso de ela ser ligada num banco que já
   * acumulou evento.
   */
  async fecharMeses(agora: Date = new Date()): Promise<number> {
    const corrente = mesLocal(agora)
    let inicio = corrente
    for (let i = 1; i < MESES_A_FECHAR; i++) inicio = mesAnterior(inicio)

    // Primeiro uso: a tabela está vazia e pode haver ano de evento no banco.
    // Recuar até o evento mais antigo é o que impede o histórico de nascer com
    // um buraco que ninguém vai notar.
    if ((await this.prisma.biEventoMes.count()) === 0) {
      const maisAntigo = await this.prisma.linkEvent.findFirst({
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      })
      if (maisAntigo) {
        const primeiro = mesLocal(maisAntigo.createdAt)
        if (primeiro < inicio) inicio = primeiro
      }
    }

    let fechados = 0
    for (let mes = inicio; mes <= corrente; mes = mesSeguinte(mes)) {
      await this.fecharMes(mes)
      fechados++
    }
    return fechados
  }

  /** Soma um mês inteiro de LinkEvent em BiEventoMes. Idempotente. */
  async fecharMes(mes: Date): Promise<number> {
    const { inicio, fim } = janelaDoMes(mes)

    const somas = await this.prisma.linkEvent.groupBy({
      by: ['profileId', 'kind'],
      where: { createdAt: { gte: inicio, lt: fim } },
      _count: { _all: true },
    })

    const linhas = somas.map((s) => ({
      mes,
      profileId: s.profileId,
      evento: s.kind,
      total: s._count._all,
    }))

    // Apagar e reescrever o mês inteiro, em vez de somar por cima: o mês
    // corrente é refeito todo dia, e um `update` incremental contaria duas vezes
    // o que já estava lá. Vale também para o perfil que perdeu todos os eventos
    // no expurgo — a linha velha some, em vez de congelar um total que já não
    // corresponde a nada.
    await this.prisma.$transaction([
      this.prisma.biEventoMes.deleteMany({ where: { mes } }),
      ...(linhas.length ? [this.prisma.biEventoMes.createMany({ data: linhas })] : []),
    ])

    return linhas.length
  }

  /** Apaga retrato mais velho que o prazo de guarda. */
  async expurgar(agora: Date = new Date()): Promise<number> {
    const limite = new Date(agora.getTime() - RETENCAO_RETRATO_DIAS * 24 * 60 * 60 * 1000)
    const r = await this.prisma.biPerfilDia.deleteMany({ where: { dia: { lt: diaLocal(limite) } } })
    return r.count
  }

  /**
   * Uma etapa não pode derrubar as outras nem a API. O pior efeito de falhar o
   * fechamento mensal hoje é refazê-lo amanhã; o pior efeito de deixar a exceção
   * subir seria perder o retrato do dia junto.
   */
  private async tentar(etapa: string, fn: () => Promise<number>): Promise<number> {
    try {
      return await fn()
    } catch (e) {
      this.log.warn(`${etapa} falhou: ${e instanceof Error ? e.message : e}`)
      return 0
    }
  }
}
