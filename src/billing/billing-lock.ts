import { ConflictException, Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service'

const PRAZO_DA_TRAVA_MS = 10 * 60 * 1000

/**
 * Mutex distribuído por perfil, persistido no Postgres. Serializa checkout,
 * cancelamento, troca e webhooks mesmo quando a API tiver mais de um processo.
 */
@Injectable()
export class BillingLockService {
  constructor(private readonly prisma: PrismaService) {}

  comPerfil<T>(profileId: string, executar: () => Promise<T>): Promise<T> {
    return this.executar({ id: profileId }, executar)
  }

  comUsuario<T>(userId: string, executar: () => Promise<T>): Promise<T> {
    return this.executar({ userId }, executar)
  }

  private async executar<T>(identidade: { id?: string; userId?: string }, acao: () => Promise<T>): Promise<T> {
    const token = randomUUID()
    const expiradaAntesDe = new Date(Date.now() - PRAZO_DA_TRAVA_MS)
    const tomada = await this.prisma.profile.updateMany({
      where: {
        ...identidade,
        OR: [
          { billingOperationId: null },
          { billingOperationAt: null },
          { billingOperationAt: { lt: expiradaAntesDe } },
        ],
      },
      data: { billingOperationId: token, billingOperationAt: new Date() },
    })
    if (tomada.count !== 1) {
      throw new ConflictException('Já existe uma operação de cobrança em andamento. Aguarde e tente novamente.')
    }

    try {
      return await acao()
    } finally {
      await this.prisma.profile
        .updateMany({
          where: { ...identidade, billingOperationId: token },
          data: { billingOperationId: null, billingOperationAt: null },
        })
        .catch(() => undefined)
    }
  }
}
