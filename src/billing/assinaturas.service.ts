import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { ProfilesService } from '../profiles/profiles.service'
import { aoVirarOPrazo } from '../assinatura'

// A VARREDURA DIÁRIA das assinaturas — quem virou de prazo desde ontem.
//
// Três coisas acontecem aqui, e só aqui:
//
//  1. REBAIXAMENTO AGENDADO que amadureceu. Quem pediu para descer de Max para Pro
//     continuou no Max até o fim do mês pago; hoje o mês virou.
//  2. ASSINATURA VENCIDA de vez — carência esgotada, ou cancelamento cujo período
//     acabou. É o único ponto do sistema que rebaixa `Profile.plan` sozinho.
//  3. ENDEREÇO cujo prazo venceu. Quem caiu para o Free ficou uma semana com o
//     endereço limpo e a data no painel; passada a semana, o número volta. É o
//     único ponto do sistema que renumera um endereço sozinho — e por isso ele
//     roda DEPOIS dos outros dois, sobre o estado já reconciliado.
//
// POR QUE UMA VARREDURA, SE A LEITURA JÁ DECIDE
//
// A leitura (planoVigente) já entrega o plano certo desde o primeiro segundo do
// vencimento — nada fica liberado à espera desta rotina, e é de propósito: uma
// tarefa agendada que não roda não pode virar recurso pago de graça.
//
// A varredura existe para o que a leitura não faz: RECONCILIAR o banco. Tema do
// Max e botão de agendar continuam gravados na linha até alguém os desligar, e
// "alguém" não pode ser o próximo save do editor — que pode nunca vir. Além disso
// é aqui que o rebaixamento agendado deixa de ser intenção e vira fato.
//
// Mesmo padrão da retenção (ver retencao.service.ts): o próprio processo acorda,
// sem cron do sistema para alguém esquecer de instalar num servidor novo. E é
// idempotente por construção — aoVirarOPrazo devolve `null` quando não há o que
// fazer, então rodar dez vezes no mesmo dia tem o efeito de rodar uma.

const INTERVALO_MS = 6 * 60 * 60 * 1000 // 4x por dia
// Assinatura é dinheiro: a primeira passagem acontece cedo, mas não no instante do
// boot — o pm2 ainda está conferindo se o processo respondeu.
const PRIMEIRA_MS = 2 * 60 * 1000
// Teto por passagem. Protege o banco de uma varredura gigante numa migração ruim;
// o que sobrar é pego na passagem seguinte, seis horas depois.
const LOTE = 500

@Injectable()
export class AssinaturasService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Assinaturas')
  private timer?: ReturnType<typeof setInterval>
  private primeira?: ReturnType<typeof setTimeout>

  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: ProfilesService,
  ) {}

  onModuleInit() {
    this.primeira = setTimeout(() => {
      void this.varrer()
      this.timer = setInterval(() => void this.varrer(), INTERVALO_MS)
      // `unref` para o temporizador não segurar o processo de pé: sem isso um
      // SIGTERM de deploy esperaria o intervalo inteiro e o pm2 mataria à força.
      this.timer.unref?.()
    }, PRIMEIRA_MS)
    this.primeira.unref?.()
  }

  onModuleDestroy() {
    if (this.primeira) clearTimeout(this.primeira)
    if (this.timer) clearInterval(this.timer)
  }

  /**
   * Uma passagem. Pública para o `npm run assinaturas` poder chamar à mão — útil
   * logo depois de um deploy, sem esperar as seis horas.
   */
  async varrer(
    agora: Date = new Date(),
  ): Promise<{ rebaixados: number; agendados: number; enderecos: number }> {
    let rebaixados = 0
    let agendados = 0
    try {
      // Só quem tem plano pago pode vencer. O Free não tem prazo, e trazê-lo aqui
      // seria varrer a tabela inteira todo dia para não fazer nada.
      const candidatos = await this.prisma.profile.findMany({
        where: {
          plan: { not: 'free' },
          OR: [
            // Rebaixamento agendado cujo período pode ter virado.
            { planScheduled: { not: null } },
            // Cobrança falhada ou assinatura encerrada — as duas têm prazo.
            { planStatus: { in: ['past_due', 'canceled'] } },
            // Ativa cujo período pago já passou: renovação que nunca chegou. Sem
            // este caso, um webhook perdido deixaria o plano de pé para sempre.
            { planStatus: 'active', currentPeriodEnd: { lt: agora } },
          ],
        },
        select: {
          id: true,
          plan: true,
          planStatus: true,
          currentPeriodEnd: true,
          graceUntil: true,
          planScheduled: true,
        },
        take: LOTE,
      })

      for (const p of candidatos) {
        const patch = aoVirarOPrazo(p as any, agora)
        if (!patch) continue
        const motivo = patch.planScheduled === null && patch.plan && patch.plan !== 'free'
          ? `rebaixamento agendado aplicado: ${p.plan} → ${patch.plan}`
          : `assinatura vencida: ${p.plan} → free`
        try {
          await this.profiles.aplicarAssinaturaPorPerfil(p.id, patch, motivo)
          if (patch.plan === 'free') rebaixados++
          else agendados++
        } catch (e) {
          // Um perfil problemático não pode interromper a varredura dos outros.
          this.log.warn(`perfil ${p.id}: ${e instanceof Error ? e.message : e}`)
        }
      }

      // Só registra quando houve o que fazer: uma linha por dia dizendo "zero" é
      // ruído que faz o log parar de ser lido.
      if (rebaixados + agendados > 0) {
        this.log.log(`varredura: ${rebaixados} assinatura(s) vencida(s), ${agendados} rebaixamento(s) agendado(s) aplicado(s)`)
      }
    } catch (e) {
      // Uma falha aqui não pode derrubar a API. O pior efeito de não varrer hoje é
      // varrer daqui a seis horas — e a LEITURA já entrega o plano certo enquanto
      // isso, então ninguém usa de graça o que não pagou.
      this.log.warn(`varredura falhou: ${e instanceof Error ? e.message : e}`)
    }

    const enderecos = await this.carimbarEnderecos(agora)
    return { rebaixados, agendados, enderecos }
  }

  /**
   * Passagem dos ENDEREÇOS vencidos. Separada da de cima, e depois dela, por um
   * motivo de ordem: quem acabou de ser rebaixado nesta mesma passagem teve o
   * prazo ABERTO agora, e portanto não é candidato hoje — o que é exatamente o
   * desejado. Ninguém perde o endereço no mesmo minuto em que perde o plano.
   *
   * Num `try` próprio: uma falha ao renumerar não pode apagar o resultado do
   * rebaixamento, que é a parte que envolve dinheiro.
   */
  private async carimbarEnderecos(agora: Date): Promise<number> {
    let carimbados = 0
    try {
      const vencidos = await this.prisma.profile.findMany({
        where: { slugGraceUntil: { not: null, lt: agora } },
        select: { id: true },
        take: LOTE,
      })

      for (const p of vencidos) {
        try {
          // A própria função reconfere o plano vigente antes de mexer — quem
          // voltou a pagar sai daqui apenas com o prazo apagado.
          if (await this.profiles.carimbarEnderecoVencido(p.id, agora)) carimbados++
        } catch (e) {
          this.log.warn(`endereço do perfil ${p.id}: ${e instanceof Error ? e.message : e}`)
        }
      }

      if (carimbados > 0) {
        this.log.log(`varredura: ${carimbados} endereço(s) devolvido(s) ao padrão do Free`)
      }
    } catch (e) {
      this.log.warn(`varredura de endereços falhou: ${e instanceof Error ? e.message : e}`)
    }
    return carimbados
  }
}
