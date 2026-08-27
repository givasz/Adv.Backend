import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { RETENCAO_EVENTOS_DIAS } from '../analytics/eventos'

// PRAZO DE GUARDA — o que apagamos, e quando.
//
// A LGPD pede que o tratamento termine quando a finalidade se cumpre (art. 15, I;
// art. 16). Duas tabelas nossas cresciam sem nenhum fim previsto:
//
//   LinkEvent — uma linha por visita e por clique, para sempre.
//   AuditLog  — uma linha por alteração de perfil, com retrato da bio, para sempre.
//
// Nenhuma das duas guarda dado de visitante (ver analytics/eventos.ts), mas
// "guardar para sempre" não é uma finalidade — e a política de privacidade que já
// está no ar promete prazo. Esta é a peça que faz a promessa valer.
//
// POR QUE UM INTERVALO E NÃO UM CRON DO SISTEMA
//
// O projeto evita cron: o vencimento das sanções, por exemplo, é conferido na
// LEITURA, para não haver tarefa agendada que alguém esquece de instalar num
// servidor novo. Aqui não dá — ninguém "lê" uma linha vencida de LinkEvent para
// descobrir que ela devia sumir; o expurgo precisa de alguém que acorde.
//
// O meio-termo é este: o próprio processo acorda. Sobe com a aplicação, morre com
// ela, e não existe um arquivo em /etc que precise ser copiado quando o servidor
// for reinstalado. O pm2 mantém o processo de pé, então na prática roda todo dia.
//
// SEGURA E REPETÍVEL: apagar por data é idempotente. Rodar duas vezes no mesmo
// dia (dois deploys seguidos, por exemplo) não apaga nada a mais.

/** Retrato de bio e resultado de conformidade: um ano cobre qualquer fiscalização. */
export const RETENCAO_AUDITORIA_DIAS = 365

const INTERVALO_MS = 24 * 60 * 60 * 1000
// Espera antes da primeira passagem: subir a aplicação e imediatamente disparar
// um DELETE grande disputaria o banco justamente no instante em que o pm2 está
// conferindo se o processo respondeu. Cinco minutos tiram um do caminho do outro.
const PRIMEIRA_MS = 5 * 60 * 1000

@Injectable()
export class RetencaoService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Retencao')
  private timer?: ReturnType<typeof setInterval>
  private primeira?: ReturnType<typeof setTimeout>

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.primeira = setTimeout(() => {
      void this.expurgar()
      this.timer = setInterval(() => void this.expurgar(), INTERVALO_MS)
      // `unref` para o temporizador não segurar o processo de pé sozinho: sem
      // isso, um `SIGTERM` de deploy esperaria até 24h para o Node achar que pode
      // sair, e o pm2 acabaria matando à força.
      this.timer.unref?.()
    }, PRIMEIRA_MS)
    this.primeira.unref?.()
  }

  onModuleDestroy() {
    if (this.primeira) clearTimeout(this.primeira)
    if (this.timer) clearInterval(this.timer)
  }

  /**
   * Apaga o que passou do prazo. Público para o `npm run retencao` poder chamar
   * uma passagem avulsa — útil logo depois de um deploy, sem esperar o intervalo.
   */
  async expurgar(): Promise<{ eventos: number; auditoria: number }> {
    try {
      const [eventos, auditoria] = await Promise.all([
        this.prisma.linkEvent.deleteMany({ where: { createdAt: { lt: limite(RETENCAO_EVENTOS_DIAS) } } }),
        this.prisma.auditLog.deleteMany({ where: { createdAt: { lt: limite(RETENCAO_AUDITORIA_DIAS) } } }),
      ])
      const total = eventos.count + auditoria.count
      // Só registra quando houve o que apagar: uma linha de log por dia dizendo
      // "apaguei zero" é ruído que faz o log parar de ser lido.
      if (total > 0) {
        this.log.log(
          `expurgo: ${eventos.count} eventos (>${RETENCAO_EVENTOS_DIAS}d), ` +
            `${auditoria.count} registros de auditoria (>${RETENCAO_AUDITORIA_DIAS}d)`,
        )
      }
      return { eventos: eventos.count, auditoria: auditoria.count }
    } catch (e) {
      // Uma falha de limpeza não pode derrubar a API: o pior efeito de não
      // apagar hoje é apagar amanhã.
      this.log.warn(`expurgo falhou: ${e instanceof Error ? e.message : e}`)
      return { eventos: 0, auditoria: 0 }
    }
  }
}

function limite(dias: number): Date {
  const d = new Date()
  d.setDate(d.getDate() - dias)
  return d
}
