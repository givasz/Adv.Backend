// Limite de gerações de IA por pessoa (12/09/2026).
//
// Havia teto, mas folgado: 80 gerações por dia para qualquer conta. Estes testes
// travam o que a capa nova promete — dia conforme o plano, respiro entre uma
// geração e outra, pedido recusado que não gasta cota, e o 429 que diz quando
// a vaga abre.

import { HttpException } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiController, mensagemDoDia } from './ai.controller'
import { AI_GERACOES_POR_DIA, resetRateLimits } from '../security/rate-limit'

const INICIO = Date.parse('2026-09-12T13:00:00-03:00')
let agora = INICIO
/** Avança o relógio: 11 s entre pedidos passa pelo respiro e pela rajada por minuto. */
const passar = (ms = 11_000) => vi.setSystemTime((agora += ms))

function controller(opcoes: { userId: string | null; plano?: 'free' | 'pro' | 'premium' }) {
  const ai = { generate: vi.fn(async () => ({ text: 'ok', complianceNotes: [], usedFallback: false })) }
  const prisma = {
    profile: {
      findUnique: vi.fn(async () => ({
        plan: opcoes.plano ?? 'free',
        planStatus: 'active',
        currentPeriodEnd: new Date(INICIO + 30 * 86_400_000),
        graceUntil: null,
      })),
    },
  }
  const sessions = { userIdFrom: vi.fn(async () => opcoes.userId) }
  const c = new AiController(ai as never, prisma as never, sessions as never)
  const gerar = (kind = 'bio', ip = '1.1.1.1') =>
    c.generate({ kind, keywords: ['família'] } as never, {} as never, ip, undefined)
  return { gerar, ai }
}

async function status(p: Promise<unknown>): Promise<{ status: number; mensagem: string }> {
  try {
    await p
    return { status: 200, mensagem: '' }
  } catch (e) {
    return { status: (e as HttpException).getStatus(), mensagem: (e as HttpException).message }
  }
}

beforeEach(() => {
  resetRateLimits()
  vi.useFakeTimers({ toFake: ['Date'] })
  agora = INICIO
  vi.setSystemTime(agora)
})
afterEach(() => vi.useRealTimers())

describe('limite de gerações de IA', () => {
  it('Free com conta: o teto do dia vale, a tela sabe quanto resta, e o 429 diz quando abre', async () => {
    const { gerar } = controller({ userId: 'u1' })
    const teto = AI_GERACOES_POR_DIA.free
    for (let i = 1; i <= teto; i++) {
      passar()
      const r = await gerar()
      expect(r.limite).toEqual({ restantesHoje: teto - i, tetoHoje: teto })
    }
    passar()
    const barrado = await status(gerar())
    expect(barrado.status).toBe(429)
    expect(barrado.mensagem).toContain(`${teto} gerações`)
    // A primeira foi às 13:00:11; a vaga abre 24 h depois, arredondada para cima.
    expect(barrado.mensagem).toContain('amanhã às 13:01')
  })

  it('sem conta, o teto é do endereço — e menor', async () => {
    const { gerar } = controller({ userId: null })
    for (let i = 0; i < AI_GERACOES_POR_DIA.anonimo; i++) {
      passar()
      await gerar()
    }
    passar()
    expect((await status(gerar())).status).toBe(429)
    // Outro endereço é outra pessoa.
    passar()
    expect((await status(gerar('bio', '2.2.2.2'))).status).toBe(200)
  })

  it('o dia cresce com o plano', async () => {
    passar()
    const pro = await controller({ userId: 'u-pro', plano: 'pro' }).gerar('bio', '3.3.3.3')
    expect(pro.limite?.tetoHoje).toBe(AI_GERACOES_POR_DIA.pro)
    passar()
    const max = await controller({ userId: 'u-max', plano: 'premium' }).gerar('bio', '4.4.4.4')
    expect(max.limite?.tetoHoje).toBe(AI_GERACOES_POR_DIA.premium)
  })

  it('pedido de recurso de outro plano é recusado sem gastar a cota', async () => {
    const { gerar, ai } = controller({ userId: 'u2' })
    for (let i = 0; i < 4; i++) expect((await status(gerar('headline'))).status).toBe(403)
    passar()
    const r = await gerar('bio')
    expect(r.limite?.restantesHoje).toBe(AI_GERACOES_POR_DIA.free - 1)
    expect(ai.generate).toHaveBeenCalledTimes(1)
  })

  it('respiro: a segunda geração no mesmo instante espera — e não gasta o dia', async () => {
    const { gerar } = controller({ userId: 'u3' })
    passar()
    await gerar()
    const colado = await status(gerar())
    expect(colado.status).toBe(429)
    expect(colado.mensagem).toContain('Aguarde alguns segundos')
    passar(5_000)
    const r = await gerar()
    expect(r.limite?.restantesHoje).toBe(AI_GERACOES_POR_DIA.free - 2)
  })
})

describe('mensagemDoDia', () => {
  it('diz a hora de Brasília quando a vaga abre no mesmo dia, e não empurra o Max', () => {
    const vaga = Date.parse('2026-09-12T16:31:20-03:00')
    const m = mensagemDoDia('premium', 60, vaga, INICIO)
    expect(m).toContain('às 16:32')
    expect(m).not.toContain('amanhã')
    expect(m).not.toContain('limite diário é maior')
  })
})
