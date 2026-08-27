import { Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import type { Plan } from '../plans'
import {
  ehEvento,
  EVENTOS_DE_CONTATO,
  JANELA_PADRAO_DIAS,
  type Evento,
} from './eventos'

// As métricas do perfil — o que o advogado vê em "Quem visita você".
//
// A tela existia e mostrava ZERO para todo mundo, sempre: lia `Profile.views`,
// uma coluna que o schema declara e que NENHUMA linha do código incrementava. A
// visita real era gravada em `LinkEvent` desde o começo e nunca lida. O upsell do
// plano Pro nessa mesma tela dizia, com o número vindo dali, "Você já recebeu 0
// visitas" — para um advogado cujo perfil podia estar circulando havia semanas.
//
// A coluna `views` foi abandonada de propósito, em vez de passar a ser
// incrementada: um contador e uma tabela de eventos contando a mesma coisa
// divergem no primeiro erro de transação, e aí não há como saber qual dos dois
// está certo. `LinkEvent` é a fonte única.
//
// Sobre o que NÃO tem aqui: ver o cabeçalho de eventos.ts. Contamos
// acontecimentos, nunca pessoas.

export interface ResumoDeMetricas {
  /** dias cobertos pelo recorte (o total é sempre desde o começo) */
  janelaDias: number
  visitas: { total: number; janela: number }
  /** cliques por tipo dentro da janela, do mais usado ao menos */
  cliques: { evento: Evento; total: number }[]
  contatos: number
  /** de cada 100 visitas, quantas terminaram em alguém tentando falar */
  taxaDeContato: number | null
  /** movimento por dia, do mais antigo ao mais recente (sempre `janelaDias` itens) */
  porDia: { dia: string; visitas: number; contatos: number }[]
  /** movimento por hora do dia (0–23), somando a janela inteira */
  porHora: number[]
  /** detalhe é recurso pago; no Free só `visitas` vem preenchido */
  detalhado: boolean
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Registra um acontecimento no perfil público.
   *
   * Assinatura enxuta de propósito: recebe o slug e o tipo, e mais nada. Não há
   * parâmetro para IP nem para identificador de sessão porque não existe lugar
   * para guardá-los — o desenho impede o próximo desenvolvedor de acrescentar
   * "só um campinho" de rastreio sem antes mudar o schema e passar por revisão.
   *
   * Silencioso: um evento que não pode ser gravado não vira erro para quem está
   * no perfil. A pessoa tocou em "WhatsApp" — o que ela precisa é que o WhatsApp
   * abra, e uma falha de métrica não pode atrapalhar isso.
   */
  async registrar(slug: string, evento: unknown): Promise<void> {
    if (!ehEvento(evento)) return
    const perfil = await this.prisma.profile.findFirst({
      where: { slug, published: true },
      select: { id: true },
    })
    if (!perfil) return
    await this.prisma.linkEvent
      .create({ data: { profileId: perfil.id, kind: evento } })
      .catch(() => undefined)
  }

  /** O resumo do perfil de quem está logado. */
  async resumoDoDono(userId: string, plano: Plan): Promise<ResumoDeMetricas> {
    const perfil = await this.prisma.profile.findUnique({
      where: { userId },
      select: { id: true },
    })
    if (!perfil) throw new NotFoundException('Perfil não encontrado')
    return this.resumo(perfil.id, plano)
  }

  private async resumo(profileId: string, plano: Plan): Promise<ResumoDeMetricas> {
    const janelaDias = JANELA_PADRAO_DIAS
    const desde = inicioDoDia(new Date())
    desde.setDate(desde.getDate() - (janelaDias - 1))

    // O total histórico e as linhas da janela. Trazemos `kind` e `createdAt` das
    // linhas do recorte e agregamos em memória: são no máximo algumas milhares
    // por perfil em 30 dias, e fazer isso no banco exigiria SQL específico de
    // Postgres (date_trunc, extract) que quebraria o SQLite do ambiente local.
    const [totalVisitas, linhas] = await Promise.all([
      this.prisma.linkEvent.count({ where: { profileId, kind: 'view' } }),
      this.prisma.linkEvent.findMany({
        where: { profileId, createdAt: { gte: desde } },
        select: { kind: true, createdAt: true },
        take: 200_000,
      }),
    ])

    const visitasJanela = linhas.filter((l) => l.kind === 'view').length

    // No Free entregamos só o volume de visitas. O detalhe (o que foi clicado,
    // em que hora) é o que os planos pagos anunciam — e o que a tela pedia sem
    // nunca ter entregue.
    if (plano === 'free') {
      return {
        janelaDias,
        visitas: { total: totalVisitas, janela: visitasJanela },
        cliques: [],
        contatos: 0,
        taxaDeContato: null,
        porDia: [],
        porHora: [],
        detalhado: false,
      }
    }

    const porTipo = new Map<string, number>()
    const porDia = new Map<string, { visitas: number; contatos: number }>()
    const porHora = new Array<number>(24).fill(0)

    // Todos os dias da janela existem no resultado, inclusive os vazios: um
    // gráfico que pula os dias sem movimento mente sobre o ritmo — três visitas
    // em três semanas viram uma linha reta que parece movimento diário.
    for (let i = 0; i < janelaDias; i++) {
      const d = new Date(desde)
      d.setDate(d.getDate() + i)
      porDia.set(chaveDoDia(d), { visitas: 0, contatos: 0 })
    }

    const contato = new Set<string>(EVENTOS_DE_CONTATO)
    let contatos = 0

    for (const linha of linhas) {
      const dia = porDia.get(chaveDoDia(linha.createdAt))
      if (linha.kind === 'view') {
        if (dia) dia.visitas++
        porHora[linha.createdAt.getHours()]++
        continue
      }
      porTipo.set(linha.kind, (porTipo.get(linha.kind) ?? 0) + 1)
      if (contato.has(linha.kind)) {
        contatos++
        if (dia) dia.contatos++
      }
    }

    return {
      janelaDias,
      visitas: { total: totalVisitas, janela: visitasJanela },
      cliques: [...porTipo.entries()]
        .map(([evento, total]) => ({ evento: evento as Evento, total }))
        .sort((a, b) => b.total - a.total),
      contatos,
      // Sem visita, a divisão não tem sentido — e `null` diz isso melhor que um
      // zero, que se leria como "ninguém entrou em contato".
      taxaDeContato: visitasJanela > 0 ? Math.round((contatos / visitasJanela) * 100) : null,
      porDia: [...porDia.entries()].map(([dia, v]) => ({ dia, ...v })),
      porHora,
      detalhado: true,
    }
  }
}

function inicioDoDia(d: Date): Date {
  const c = new Date(d)
  c.setHours(0, 0, 0, 0)
  return c
}

/** AAAA-MM-DD no fuso do servidor — o mesmo em que o advogado lê a tela. */
function chaveDoDia(d: Date): string {
  const mes = String(d.getMonth() + 1).padStart(2, '0')
  const dia = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mes}-${dia}`
}
