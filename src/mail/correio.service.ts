// A fila de e-mail e quem a esvazia.
//
// QUEM USA chama `enfileirar` e segue a vida. Enfileirar NUNCA lança: o e-mail é
// consequência de uma ação (suspender, trocar senha, denunciar), e uma falha no
// correio não pode desfazer nem travar a ação que o motivou.
//
// QUEM ENVIA é o despachante deste serviço, que acorda sozinho — mesma escolha do
// RetencaoService: nada em /etc para esquecer de instalar num servidor novo.
// Acorda de três jeitos: logo depois de um aviso entrar (quem pediu senha nova
// está olhando a caixa de entrada), a cada 30 segundos, e no boot.
//
// O QUE ELE GARANTE
//
//   • Um aviso sai uma vez. A linha é "arrendada" com um `updateMany` condicionado
//     antes do envio (dois processos não pegam a mesma), e a chave de
//     idempotência do Resend é o id da linha (se o processo cair depois de o
//     provedor aceitar, a repetição não vira segundo e-mail).
//   • Quem espera na tela passa na frente. Prioridade 0 (senha, confirmação) sai
//     antes de aviso sobre a conta, que sai antes de aviso em massa — e o aviso em
//     massa nunca gasta a reserva do dia (ver RESERVA_DO_DIA).
//   • Falha passageira tenta de novo com espera crescente; falha permanente para
//     de tentar; chave recusada ou cota estourada põem o provedor inteiro em
//     espera sem descartar nada.
//   • Depois de sair (ou falhar, ou vencer), a linha perde o endereço e os dados.
//     Fica o modelo, a impressão digital de quem recebeu e a data.

import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { fingerprint } from '../security/audit-log'
import { safeEmail } from '../security/sanitize'
import { configDoCorreio, type ConfigDoCorreio } from './config'
import { modeloValido, PRIORIDADE, renderizar, type Mensagem, type Modelo } from './modelos'
import { enviarPeloResend, type ResultadoEnvio } from './resend'

const INTERVALO_MS = 30_000
const PRIMEIRA_MS = 10_000
/** Quantos avisos uma passada olha. O resto fica para a próxima. */
const LOTE = 20
/** Folga entre dois envios: o Resend aceita poucas chamadas por segundo por conta. */
const ESPACO_MS = 600
/** Quanto tempo uma linha fica "nossa" enquanto sai. Se o processo morrer, ela volta. */
const ARRENDAMENTO_MS = 2 * 60_000
const MAX_TENTATIVAS = 8
/** Quanto do teto diário fica guardado para senha e aviso de conta. */
export const RESERVA_DO_DIA = 20
const DIA_MS = 24 * 60 * 60 * 1000

export interface NovoAviso {
  modelo: Modelo
  para: string
  dados?: Record<string, unknown>
  userId?: string | null
  /** Trava contra repetição: dois avisos com a mesma chave viram um. */
  chave?: string
  /** Link com prazo: depois disto o aviso não sai mais. */
  validoAte?: Date | null
}

export interface ResumoDaPassada {
  enviados: number
  falhas: number
  adiados: number
}

/** 1, 2, 4, 8… minutos entre as tentativas, até 6 horas. */
export function esperaDaTentativa(tentativas: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, tentativas - 1), 6 * 60 * 60 * 1000)
}

interface Candidato {
  id: string
  modelo: string
  para: string
  dados: string
  prioridade: number
  tentativas: number
  validoAte: Date | null
  destinatario: string
}

@Injectable()
export class CorreioService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Correio')

  /** Lida do ambiente no boot. Público para os testes trocarem. */
  config: ConfigDoCorreio = configDoCorreio(process.env)
  /** Quem de fato entrega. Público para os testes trocarem. */
  transporte: typeof enviarPeloResend = enviarPeloResend
  esperar: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))

  private timer?: ReturnType<typeof setInterval>
  private primeira?: ReturnType<typeof setTimeout>
  private cutucada?: ReturnType<typeof setTimeout>
  private passada: Promise<ResumoDaPassada> | null = null
  private repetir = false
  /** Provedor inteiro em espera (cota do dia, chave recusada, rajada). */
  private pausadoAte = 0

  constructor(private readonly prisma: PrismaService) {}

  /** Há entrega? Quem mostra "enviamos um link" na tela precisa saber. */
  get ativo(): boolean {
    return this.config.ativo
  }

  onModuleInit() {
    if (!this.config.ativo) return
    this.primeira = setTimeout(() => {
      void this.despachar()
      this.timer = setInterval(() => void this.despachar(), INTERVALO_MS)
      this.timer.unref?.()
    }, PRIMEIRA_MS)
    this.primeira.unref?.()
  }

  onModuleDestroy() {
    if (this.primeira) clearTimeout(this.primeira)
    if (this.timer) clearInterval(this.timer)
    if (this.cutucada) clearTimeout(this.cutucada)
  }

  // ---- Entrada ---------------------------------------------------------------

  /** Põe um aviso na fila. Devolve `false` se não entrou (endereço inválido, repetido, banco fora). */
  async enfileirar(a: NovoAviso): Promise<boolean> {
    const para = safeEmail(a.para)
    if (!para || !modeloValido(a.modelo)) return false
    try {
      await this.prisma.mailOutbox.create({
        data: {
          modelo: a.modelo,
          para,
          destinatario: fingerprint(para) ?? '',
          userId: a.userId ?? null,
          dados: JSON.stringify(a.dados ?? {}),
          chave: a.chave ?? null,
          prioridade: PRIORIDADE[a.modelo],
          validoAte: a.validoAte ?? null,
        },
      })
    } catch (e) {
      // Chave repetida é o comportamento pedido, não um erro.
      if ((e as { code?: string } | null)?.code === 'P2002') return false
      this.log.warn(`não deu para enfileirar "${a.modelo}": ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
    this.cutucar()
    return true
  }

  /** Uma passada logo — quem pediu senha nova não deve esperar o intervalo. */
  private cutucar() {
    if (!this.config.ativo || this.cutucada) return
    this.cutucada = setTimeout(() => {
      this.cutucada = undefined
      void this.despachar()
    }, 50)
    this.cutucada.unref?.()
  }

  // ---- Saída -----------------------------------------------------------------

  /**
   * Esvazia o que dá da fila. Uma passada por vez: quem chama durante uma passada
   * recebe a mesma promessa, e a passada dá mais uma volta no fim para pegar o
   * que entrou no meio.
   */
  despachar(): Promise<ResumoDaPassada> {
    if (this.passada) {
      this.repetir = true
      return this.passada
    }
    const p = this.executar()
    this.passada = p
    void p.finally(() => {
      if (this.passada === p) this.passada = null
    })
    return p
  }

  private async executar(): Promise<ResumoDaPassada> {
    const total: ResumoDaPassada = { enviados: 0, falhas: 0, adiados: 0 }
    try {
      do {
        this.repetir = false
        const r = await this.umaPassada()
        total.enviados += r.enviados
        total.falhas += r.falhas
        total.adiados += r.adiados
      } while (this.repetir)
    } catch (e) {
      // Banco fora do ar, por exemplo. A próxima passada tenta de novo.
      this.log.warn(`passada interrompida: ${e instanceof Error ? e.message : String(e)}`)
    }
    return total
  }

  private async umaPassada(): Promise<ResumoDaPassada> {
    const r: ResumoDaPassada = { enviados: 0, falhas: 0, adiados: 0 }
    if (!this.config.ativo || this.pausadoAte > Date.now()) return r

    const candidatos: Candidato[] = await this.prisma.mailOutbox.findMany({
      where: { status: 'pendente', proximaTentativa: { lte: new Date() } },
      orderBy: [{ prioridade: 'asc' }, { createdAt: 'asc' }],
      take: LOTE,
      select: {
        id: true,
        modelo: true,
        para: true,
        dados: true,
        prioridade: true,
        tentativas: true,
        validoAte: true,
        destinatario: true,
      },
    })
    if (!candidatos.length) return r

    let enviadosNoDia = await this.prisma.mailOutbox.count({
      where: { status: 'enviado', enviadoEm: { gte: new Date(Date.now() - DIA_MS) } },
    })
    let saiuAlgum = false

    for (const c of candidatos) {
      if (this.pausadoAte > Date.now()) break

      if (c.prioridade >= 2 && enviadosNoDia >= this.config.tetoDiario - RESERVA_DO_DIA) {
        r.adiados++
        continue
      }
      if (!(await this.arrendar(c.id))) continue

      if (c.validoAte && c.validoAte.getTime() <= Date.now()) {
        await this.encerrar(c.id, 'expirado', 'o link venceu antes de sair')
        r.falhas++
        continue
      }

      let mensagem: Mensagem
      try {
        mensagem = renderizar(c.modelo, JSON.parse(c.dados) as Record<string, unknown>, {
          site: this.config.siteUrl,
        })
      } catch (e) {
        await this.encerrar(c.id, 'falhou', `modelo: ${e instanceof Error ? e.message : String(e)}`)
        this.log.warn(`aviso ${c.id} ("${c.modelo}") não pôde ser montado`)
        r.falhas++
        continue
      }

      if (saiuAlgum && this.config.modo === 'resend') await this.esperar(ESPACO_MS)
      saiuAlgum = true
      const resultado = await this.entregar(c, mensagem)

      if (resultado.ok) {
        await this.prisma.mailOutbox.update({
          where: { id: c.id },
          data: {
            status: 'enviado',
            enviadoEm: new Date(),
            provedorId: resultado.id.slice(0, 100),
            erro: '',
            para: '',
            dados: '{}',
          },
        })
        enviadosNoDia++
        r.enviados++
        this.log.log(`enviado "${c.modelo}" para ${c.destinatario}`)
        continue
      }
      await this.tratarFalha(c, resultado, r)
    }
    return r
  }

  private async entregar(c: Candidato, m: Mensagem): Promise<ResultadoEnvio> {
    if (this.config.modo === 'console') {
      // Só existe fora de produção (ver config.ts) — é o jeito de clicar no link
      // de redefinição na máquina local.
      this.log.log(`\n──── e-mail "${c.modelo}" para ${c.para}\nAssunto: ${m.assunto}\n\n${m.texto}\n────`)
      return { ok: true, id: 'console' }
    }
    return this.transporte({
      apiKey: this.config.apiKey,
      de: this.config.remetente,
      para: c.para,
      assunto: m.assunto,
      html: m.html,
      texto: m.texto,
      chaveDeIdempotencia: c.id,
      etiqueta: c.modelo,
    })
  }

  private async tratarFalha(
    c: Candidato,
    res: Extract<ResultadoEnvio, { ok: false }>,
    r: ResumoDaPassada,
  ): Promise<void> {
    // O provedor inteiro espera, e ninguém perde o aviso: cota do dia, chave
    // recusada e rajada acima do limite por segundo não são culpa DESTE aviso.
    if (res.tipo === 'cota' || res.tipo === 'credencial' || res.status === 429) {
      this.pausadoAte = Date.now() + (res.esperarMs ?? 10 * 60_000)
      await this.prisma.mailOutbox.update({
        where: { id: c.id },
        data: { proximaTentativa: new Date(this.pausadoAte), erro: res.erro },
      })
      const grave = res.tipo === 'credencial' || res.tipo === 'cota'
      this.log[grave ? 'error' : 'warn'](
        `provedor recusou (${res.tipo}): ${res.erro} — fila em espera até ${new Date(this.pausadoAte).toISOString()}`,
      )
      r.adiados++
      return
    }

    const tentativas = c.tentativas + 1
    if (res.tipo === 'permanente' || tentativas >= MAX_TENTATIVAS) {
      await this.encerrar(c.id, 'falhou', res.erro, tentativas)
      this.log.warn(`"${c.modelo}" para ${c.destinatario} desistido depois de ${tentativas} tentativa(s): ${res.erro}`)
      r.falhas++
      return
    }
    await this.prisma.mailOutbox.update({
      where: { id: c.id },
      data: {
        tentativas,
        erro: res.erro,
        proximaTentativa: new Date(Date.now() + Math.max(res.esperarMs ?? 0, esperaDaTentativa(tentativas))),
      },
    })
    r.adiados++
  }

  /** A linha é nossa? Só um processo ganha. */
  private async arrendar(id: string): Promise<boolean> {
    const agora = new Date()
    const { count } = await this.prisma.mailOutbox.updateMany({
      where: { id, status: 'pendente', proximaTentativa: { lte: agora } },
      data: { proximaTentativa: new Date(agora.getTime() + ARRENDAMENTO_MS) },
    })
    return count === 1
  }

  /** Fim da linha para o aviso: some o endereço e os dados, fica o registro. */
  private async encerrar(id: string, status: 'falhou' | 'expirado', erro: string, tentativas?: number) {
    await this.prisma.mailOutbox.update({
      where: { id },
      data: { status, erro: erro.slice(0, 300), para: '', dados: '{}', ...(tentativas ? { tentativas } : {}) },
    })
  }
}
