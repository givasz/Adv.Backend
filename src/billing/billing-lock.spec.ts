import { describe, expect, it, vi } from 'vitest'
import { ConflictException } from '@nestjs/common'
import { BillingLockService } from './billing-lock'

describe('trava distribuída da cobrança', () => {
  it('permite só uma operação financeira por perfil de cada vez e libera ao terminar', async () => {
    let token: string | null = null
    const prisma = {
      profile: {
        updateMany: vi.fn(async (arg: any) => {
          if (arg.data.billingOperationId === null) {
            if (token === arg.where.billingOperationId) token = null
            return { count: 1 }
          }
          if (token) return { count: 0 }
          token = arg.data.billingOperationId
          return { count: 1 }
        }),
      },
    }
    const lock = new BillingLockService(prisma as any)
    let liberar!: () => void
    const primeira = lock.comPerfil('p1', () => new Promise<string>((resolve) => (liberar = () => resolve('ok'))))
    await vi.waitFor(() => expect(token).not.toBeNull())

    await expect(lock.comPerfil('p1', async () => 'duplicada')).rejects.toBeInstanceOf(ConflictException)
    liberar()
    await expect(primeira).resolves.toBe('ok')
    await expect(lock.comPerfil('p1', async () => 'depois')).resolves.toBe('depois')
  })
})
