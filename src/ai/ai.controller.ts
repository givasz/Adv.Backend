import { Body, Controller, ForbiddenException, Headers, Ip, Post, Req } from '@nestjs/common'
import { AiService, type GenerateDto, type GenerateResult } from './ai.service'
import { PrismaService } from '../prisma/prisma.service'
import { SessionService } from '../auth/session.service'
import type { RequisicaoComAuth } from '../auth/session-context'
import { AI_RATE_RULES, enforceRateLimit } from '../security/rate-limit'
import { clientIp } from '../security/net'
import { planoVigente } from '../assinatura'

// Recursos de IA por plano — FONTE DA VERDADE do servidor. Espelha
// frontend/src/lib/aiFeatures.ts, que decide qual botão aparece; aqui é onde a
// regra realmente vale, porque um `plan: "premium"` no corpo do JSON não prova
// assinatura nenhuma.
const AI_MIN_PLAN: Record<string, 'free' | 'pro' | 'premium'> = {
  bio: 'free',
  area: 'free',
  headline: 'pro',
  improve: 'pro',
  faq: 'pro',
}
const RANK: Record<string, number> = { free: 0, pro: 1, premium: 2 }

@Controller('ai')
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
  ) {}

  // POST /api/ai/generate  → { text, complianceNotes }
  @Post('generate')
  async generate(
    @Body() dto: GenerateDto,
    @Req() req: RequisicaoComAuth,
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
  ): Promise<GenerateResult> {
    const userId = await this.sessions.userIdFrom(req)

    // Cada geração custa dinheiro num provedor pago. Sem teto, um laço de terminal
    // esvazia o orçamento da conta em minutos — e a rota é pública de propósito
    // (o Free sem conta usa a IA de bio/área).
    const limites: [string, (typeof AI_RATE_RULES)['perIp']][] = [
      [`ai:ip:${clientIp(ip, xff)}`, AI_RATE_RULES.perIp],
      [`ai:burst:${clientIp(ip, xff)}`, AI_RATE_RULES.perIpBurst],
    ]
    if (userId) limites.push([`ai:user:${userId}`, AI_RATE_RULES.perUser])
    enforceRateLimit(limites, 'Muitas gerações em pouco tempo. Aguarde um instante e tente de novo.')

    // O PLANO É DO SERVIDOR (mesma regra do PUT /profiles/me): vem da assinatura
    // gravada no banco. Sem sessão, é free — e free só gera bio e área.
    const plan = await this.planoDoUsuario(userId)
    const kind = typeof dto?.kind === 'string' ? dto.kind : 'bio'
    const minimo = AI_MIN_PLAN[kind] ?? 'premium'
    if ((RANK[plan] ?? 0) < (RANK[minimo] ?? 99)) {
      throw new ForbiddenException('Esse recurso de IA faz parte de um plano superior.')
    }

    return this.ai.generate({ ...dto, kind: kind as GenerateDto['kind'], plan })
  }

  private async planoDoUsuario(userId: string | null): Promise<'free' | 'pro' | 'premium'> {
    if (!userId) return 'free'
    try {
      const p = await this.prisma.profile.findUnique({
        where: { userId },
        // O plano CONTRATADO não basta: quem não pagou não usa a IA do plano. Quem
        // responde "o que vale agora" é planoVigente (ver src/assinatura.ts).
        select: { plan: true, planStatus: true, currentPeriodEnd: true, graceUntil: true },
      })
      return p ? planoVigente(p) : 'free'
    } catch {
      // Banco fora do ar → falha fechada no plano mais restrito, não no mais alto.
      return 'free'
    }
  }
}
