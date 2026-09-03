// Contestação — o que torna o prazo real.
//
// A política prometia contraditório (docs/politica-de-sancoes.md § 5) e o
// produto não tinha onde recebê-lo. Uma sanção que a pessoa não consegue
// contestar é uma sanção indefensável, e um prazo sem consequência é decoração.
//
// Duas decisões de desenho carregam este arquivo:
//
// **1. O relógio não é máquina nova.** Contestar ENCURTA o `moderationUntil` da
// medida para 10 dias. Passado o prazo sem resposta, a medida cai pelo mesmo
// vencimento preguiçoso que já existia (ver admin/sancoes.ts) — sem cron para
// esquecer de rodar, sem varredura, sem estado paralelo que possa divergir.
// Rejeitada a contestação, `prazoOriginal` devolve o prazo que havia.
//
// **2. O relógio só corre depois de alguém contestar.** Medida não contestada
// não cai por silêncio. Sem esse recorte, um perfil irregular voltaria ao ar
// porque ninguém olhou a fila durante uma semana de férias.
//
// E o caso que quase passou batido: **a suspensão tira o canal de contestar**.
// Conta suspensa não loga, e sem logar não há como escrever. Daí a autenticação
// por e-mail e senha SEM abrir sessão (`abrirPorCredencial`): a pessoa prova
// quem é, escreve, e não ganha acesso a mais nada.

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { verifyPassword, burnPasswordTime } from '../auth/user-auth'
import { degrau } from '../admin/sancoes'
import { faixa, pagina } from '../admin/paginacao'

/** Dias que a plataforma tem para responder. Ver política, § 5. */
const RESPOSTA_DIAS = 10
const DIA = 24 * 60 * 60 * 1000
const TEXTO_MIN = 20
const TEXTO_MAX = 4000

interface Alvo {
  userId: string
  alvo: 'profile' | 'account'
  medida: string
  /** Prazo atual da medida no perfil, se houver. */
  prazoAtual: Date | null
  profileId: string | null
}

@Injectable()
export class AppealsService {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Descobrir o que há para contestar ------------------------------------

  /**
   * A medida vigente sobre esta conta, ou null.
   *
   * A da CONTA vem primeiro: quem está suspenso contesta a suspensão, não a
   * restrição do perfil que veio junto dela.
   */
  private async medidaVigenteDe(userId: string): Promise<Alvo | null> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        closedAt: true,
        suspendedUntil: true,
        profile: {
          select: { id: true, moderationStatus: true, moderationUntil: true },
        },
      },
    })
    if (!u) return null

    const agora = Date.now()
    if (u.closedAt) {
      return { userId, alvo: 'account', medida: 'close', prazoAtual: null, profileId: u.profile?.id ?? null }
    }
    if (u.suspendedUntil && u.suspendedUntil.getTime() > agora) {
      return {
        userId,
        alvo: 'account',
        medida: 'suspend',
        prazoAtual: u.suspendedUntil,
        profileId: u.profile?.id ?? null,
      }
    }
    const p = u.profile
    if (p && p.moderationStatus !== 'active') {
      // Medida de perfil vencida não é contestável: ela já caiu sozinha.
      if (p.moderationUntil && p.moderationUntil.getTime() <= agora) return null
      const medida =
        p.moderationStatus === 'warned' ? 'warn' : p.moderationStatus === 'partial' ? 'partial' : 'restrict'
      return { userId, alvo: 'profile', medida, prazoAtual: p.moderationUntil, profileId: p.id }
    }
    return null
  }

  /** A janela de contestação ainda está aberta? Ver a escada. */
  private dentroDoPrazo(medida: string, aplicadaEm: Date | null): boolean {
    const d = degrau(medida)
    if (!d) return false
    if (!aplicadaEm) return true // medidas antigas, sem data — não fechamos a porta
    return aplicadaEm.getTime() + d.contestacaoDias * DIA > Date.now()
  }

  // ---- Abrir ----------------------------------------------------------------

  /** O que o advogado logado pode contestar agora, e o que já contestou. */
  async minhas(userId: string) {
    const [alvo, abertas] = await Promise.all([
      this.medidaVigenteDe(userId),
      this.prisma.appeal.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ])
    const jaAberta = abertas.some((a) => a.status === 'open')
    return {
      podeContestar: !!alvo && !jaAberta,
      medida: alvo?.medida ?? null,
      alvo: alvo?.alvo ?? null,
      respostaEmDias: RESPOSTA_DIAS,
      contestacoes: abertas,
    }
  }

  async abrir(userId: string, texto: string) {
    const limpo = (texto ?? '').trim()
    if (limpo.length < TEXTO_MIN) {
      throw new BadRequestException(
        `Explique por que discorda, com pelo menos ${TEXTO_MIN} caracteres. É o texto que o revisor vai ler.`,
      )
    }

    const alvo = await this.medidaVigenteDe(userId)
    if (!alvo) throw new BadRequestException('Não há medida em vigor para contestar.')

    const jaAberta = await this.prisma.appeal.findFirst({
      where: { userId, status: 'open' },
      select: { id: true, respondeAte: true },
    })
    if (jaAberta) {
      throw new BadRequestException(
        `Você já tem uma contestação em aberto. Respondemos até ${jaAberta.respondeAte.toLocaleDateString('pt-BR')}.`,
      )
    }

    const respondeAte = new Date(Date.now() + RESPOSTA_DIAS * DIA)

    const criada = await this.prisma.$transaction(async (tx) => {
      const a = await tx.appeal.create({
        data: {
          userId,
          alvo: alvo.alvo,
          medida: alvo.medida,
          texto: limpo.slice(0, TEXTO_MAX),
          respondeAte,
          prazoOriginal: alvo.prazoAtual,
        },
      })

      // O relógio. Encurtar o prazo da medida é o que faz o silêncio ter
      // consequência — e reaproveita o vencimento que já existe, em vez de
      // inventar um segundo mecanismo que pudesse divergir dele.
      //
      // `min`: se a medida já vencia ANTES dos 10 dias, ela continua vencendo
      // antes. Contestar nunca pode esticar uma sanção.
      const novoPrazo =
        alvo.prazoAtual && alvo.prazoAtual.getTime() < respondeAte.getTime()
          ? alvo.prazoAtual
          : respondeAte

      if (alvo.alvo === 'account') {
        await tx.user.update({ where: { id: userId }, data: { suspendedUntil: novoPrazo } })
      }
      if (alvo.profileId) {
        await tx.profile.update({ where: { id: alvo.profileId }, data: { moderationUntil: novoPrazo } })
      }
      return a
    })

    return { ok: true, respondeAte: criada.respondeAte, id: criada.id }
  }

  /**
   * Contestação de quem NÃO consegue entrar.
   *
   * A suspensão bloqueia o login — e bloquear o login tira o canal de contestar
   * a própria suspensão. Aqui a pessoa prova quem é com e-mail e senha e **não
   * ganha sessão nenhuma**: escreve a contestação e pronto. O modelo de sessão
   * fica intacto, e ninguém precisa de e-mail para ser ouvido.
   *
   * Falha com a MESMA mensagem em credencial errada e em conta sem medida: esta
   * rota não pode virar um oráculo de quem foi sancionado na plataforma.
   */
  async abrirPorCredencial(email: unknown, senha: unknown, texto: string) {
    const mail = typeof email === 'string' ? email.trim().toLowerCase() : ''
    const pass = typeof senha === 'string' ? senha : ''
    const generico = new ForbiddenException(
      'Não foi possível abrir a contestação com esses dados. Confira o e-mail e a senha.',
    )

    const user = await this.prisma.user.findUnique({
      where: { email: mail },
      select: { id: true, password: true, suspendedUntil: true, closedAt: true },
    })
    if (!user) {
      await burnPasswordTime(pass)
      throw generico
    }
    if (!(await verifyPassword(pass, user.password))) throw generico

    // Só quem está de fato impedido de entrar usa esta porta. Quem consegue
    // logar contesta pelo painel, onde há contexto.
    const suspensa = !!user.suspendedUntil && user.suspendedUntil.getTime() > Date.now()
    if (!suspensa && !user.closedAt) throw generico

    // A janela de 30 dias do encerramento (política, § 4) fecha esta porta
    // depois. Sem isso, uma conta encerrada há dois anos ainda reabriria caso.
    if (user.closedAt && user.closedAt.getTime() + 30 * DIA < Date.now()) {
      throw new ForbiddenException('O prazo para contestar esta decisão já passou.')
    }

    return this.abrir(user.id, texto)
  }

  // ---- Fila do painel --------------------------------------------------------

  async listar(status = 'open', limite?: unknown, offset?: unknown) {
    const where = status === 'all' ? {} : { status }
    const { take, skip } = faixa(limite, offset)
    const [itens, total] = await this.prisma.$transaction([
      this.prisma.appeal.findMany({
        where,
        // O que vence primeiro na frente: a fila é um relógio, não um mural.
        orderBy: [{ respondeAte: 'asc' }, { id: 'asc' }],
        take,
        skip,
        include: {
          user: {
            select: {
              email: true,
              suspendedUntil: true,
              closedAt: true,
              profile: { select: { id: true, name: true, slug: true, moderationNote: true } },
            },
          },
        },
      }),
      this.prisma.appeal.count({ where }),
    ])
    return pagina(itens, total, take, skip)
  }

  /** Quantas estão vencendo — o número que o painel mostra na aba. */
  async contadores() {
    const [abertas, vencendo] = await Promise.all([
      this.prisma.appeal.count({ where: { status: 'open' } }),
      this.prisma.appeal.count({
        where: { status: 'open', respondeAte: { lt: new Date(Date.now() + 2 * DIA) } },
      }),
    ])
    return { abertas, vencendo }
  }

  // ---- Decidir ---------------------------------------------------------------

  /**
   * Responde a contestação.
   *
   * `aceita` derruba a medida; recusar devolve o prazo original — contestar não
   * pode encurtar a sanção de quem contestou sem razão, nem esticá-la.
   */
  async decidir(
    id: string,
    aceita: boolean,
    resposta: string,
    quemDecidiu: string | null,
  ) {
    const a = await this.prisma.appeal.findUnique({
      where: { id },
      select: { id: true, userId: true, alvo: true, status: true, prazoOriginal: true },
    })
    if (!a) throw new NotFoundException('Contestação não encontrada.')
    if (a.status !== 'open') throw new BadRequestException('Esta contestação já foi respondida.')

    const perfil = await this.prisma.profile.findUnique({
      where: { userId: a.userId },
      select: { id: true, planStatus: true },
    })

    await this.prisma.$transaction(async (tx) => {
      await tx.appeal.update({
        where: { id },
        data: {
          status: aceita ? 'accepted' : 'rejected',
          resposta: resposta.slice(0, 2000),
          decidedAt: new Date(),
          decidedBy: quemDecidiu,
        },
      })

      if (aceita) {
        // A medida cai por inteiro — inclusive a suspensão da conta e a pausa da
        // cobrança, que existiam por causa dela.
        await tx.user.update({
          where: { id: a.userId },
          data: { suspendedAt: null, suspendedUntil: null, suspendedReason: '' },
        })
        if (perfil) {
          await tx.profile.update({
            where: { id: perfil.id },
            data: {
              moderationStatus: 'active',
              moderationNote: '',
              moderationUntil: null,
              hiddenSections: '[]',
              billingPausedAt: null,
              // A cobrança volta a correr só se tinha sido a medida a pará-la —
              // uma contestação aceita não transforma em "em dia" uma assinatura
              // que já estava em atraso antes da sanção.
              ...(perfil.planStatus === 'paused' ? { planStatus: 'active' as const } : {}),
            },
          })
        }
      } else {
        // Mantida: o prazo volta ao que era antes de o relógio da contestação
        // encurtá-lo.
        if (a.alvo === 'account') {
          await tx.user.update({ where: { id: a.userId }, data: { suspendedUntil: a.prazoOriginal } })
        }
        if (perfil) {
          await tx.profile.update({
            where: { id: perfil.id },
            data: { moderationUntil: a.prazoOriginal },
          })
        }
      }
    })

    return { ok: true, aceita }
  }

  /**
   * Marca como vencidas as contestações que a plataforma deixou passar.
   *
   * A MEDIDA já caiu sozinha (o prazo dela foi encurtado na abertura); isto aqui
   * só acerta o rótulo, para o histórico não mentir dizendo que a contestação
   * ainda está aberta. Roda quando o painel abre a fila — caminho autenticado e
   * de baixa frequência, em vez de uma varredura agendada.
   */
  async encerrarVencidas(): Promise<number> {
    const { count } = await this.prisma.appeal.updateMany({
      where: { status: 'open', respondeAte: { lt: new Date() } },
      data: { status: 'expired', decidedAt: new Date() },
    })
    return count
  }
}
