import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { PartnersService } from './partners.service'

// A VARREDURA DO PROGRAMA PARCEIROS — mesmo desenho de billing/assinaturas.service:
// o próprio processo acorda, sem cron do sistema para alguém esquecer de instalar.
//
// Cinco passos, nesta ordem, cada um no seu `try`:
//
//  1. Recompensas cuja validação de 7 dias terminou → confirmadas, dias somados.
//  2. Pendentes de participação encerrada → revogadas (não amadurecem).
//  3. Benefício que venceu → o perfil é reconciliado UMA vez (tema, agenda,
//     prazo do endereço). Os recursos já tinham fechado na leitura, no segundo do
//     vencimento: nada aqui é condição para alguém perder o Max na hora certa.
//  4. Benefício que acaba em até 7 dias → um aviso por prazo.
//  5. Convite por e-mail não usado em 90 dias → apagado (é e-mail de quem nunca
//     se cadastrou).
//
// Idempotente: rodar dez vezes tem o efeito de rodar uma. Lotes limitados; o que
// sobrar fica para a passagem seguinte. Uma linha problemática não para as outras.

const INTERVALO_MS = 60 * 60 * 1000 // de hora em hora: a validação conta dias, não minutos
const PRIMEIRA_MS = 3 * 60 * 1000
const LOTE = 200

@Injectable()
export class PartnerMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ParceirosVarredura')
  private timer?: ReturnType<typeof setInterval>
  private primeira?: ReturnType<typeof setTimeout>
  private rodando = false

  constructor(private readonly partners: PartnersService) {}

  onModuleInit() {
    this.primeira = setTimeout(() => {
      void this.varrer()
      this.timer = setInterval(() => void this.varrer(), INTERVALO_MS)
      this.timer.unref?.()
    }, PRIMEIRA_MS)
    this.primeira.unref?.()
  }

  onModuleDestroy() {
    if (this.primeira) clearTimeout(this.primeira)
    if (this.timer) clearInterval(this.timer)
  }

  async varrer(agora: Date = new Date()) {
    // Duas passagens sobrepostas no mesmo processo só gastariam banco: a segunda
    // espera a próxima hora. Entre processos, quem garante é o banco (CAS e chaves).
    if (this.rodando) return { confirmadas: 0, revogadas: 0, reconciliados: 0, avisados: 0 }
    this.rodando = true
    const passo = async (nome: string, fn: () => Promise<number>) => {
      try {
        return await fn()
      } catch (e) {
        this.log.warn(`${nome} falhou: ${e instanceof Error ? e.message : e}`)
        return 0
      }
    }
    try {
      const confirmadas = await passo('confirmação', () => this.partners.confirmarPendentes(agora, LOTE))
      const revogadas = await passo('revogação de encerradas', () => this.partners.revogarDeEncerrados(agora, LOTE))
      const reconciliados = await passo('fim do benefício', () => this.partners.reconciliarVencidos(agora, LOTE))
      const avisados = await passo('aviso de fim', () => this.partners.avisarExpirando(agora, LOTE))
      await passo('convites por e-mail vencidos', () => this.partners.expurgarConvitesVencidos(agora))
      if (confirmadas + revogadas + reconciliados > 0) {
        this.log.log(`varredura: ${confirmadas} confirmada(s), ${revogadas} revogada(s), ${reconciliados} benefício(s) encerrado(s)`)
      }
      return { confirmadas, revogadas, reconciliados, avisados }
    } finally {
      this.rodando = false
    }
  }
}
