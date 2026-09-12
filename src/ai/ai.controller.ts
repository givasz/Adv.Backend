import { Body, Controller, ForbiddenException, Headers, Ip, Post, Req } from '@nestjs/common'
import { AiService, type GenerateDto, type GenerateResult } from './ai.service'
import { PrismaService } from '../prisma/prisma.service'
import { SessionService } from '../auth/session.service'
import type { RequisicaoComAuth } from '../auth/session-context'
import {
  AI_RATE_RULES,
  enforceRateLimit,
  proximaVaga,
  regraDoDia,
  restantes,
  type QuemGera,
} from '../security/rate-limit'
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

  // POST /api/ai/generate  → { text, complianceNotes, limite }
  @Post('generate')
  async generate(
    @Body() dto: GenerateDto,
    @Req() req: RequisicaoComAuth,
    @Ip() ip?: string,
    @Headers('x-forwarded-for') xff?: string,
  ): Promise<GenerateResult> {
    const userId = await this.sessions.userIdFrom(req)
    const ipCliente = clientIp(ip, xff)

    // 1. O ENDEREÇO, com ou sem conta — antes de qualquer consulta ao banco. Cada
    //    geração custa cota num provedor, e a rota é pública de propósito (o Free
    //    sem conta usa a IA de bio/área).
    enforceRateLimit(
      [
        [`ai:burst:${ipCliente}`, AI_RATE_RULES.perIpBurst],
        [`ai:ip:${ipCliente}`, AI_RATE_RULES.perIp],
        [`ai:ip-dia:${ipCliente}`, AI_RATE_RULES.perIpDayTotal],
      ],
      'Muitas gerações em pouco tempo. Aguarde um instante e tente de novo.',
    )

    // 2. O PLANO É DO SERVIDOR (mesma regra do PUT /profiles/me): vem da assinatura
    //    gravada no banco. Sem sessão, é free — e free só gera bio e área.
    //    Vem ANTES das cotas da pessoa: pedido recusado não gasta a cota de ninguém.
    const plan = await this.planoDoUsuario(userId)
    const kind = typeof dto?.kind === 'string' ? dto.kind : 'bio'
    const minimo = AI_MIN_PLAN[kind] ?? 'premium'
    if ((RANK[plan] ?? 0) < (RANK[minimo] ?? 99)) {
      throw new ForbiddenException('Esse recurso de IA faz parte de um plano superior.')
    }

    // 3. A PESSOA: respiro, hora e o dia do plano. Sem conta, a pessoa é o IP.
    const ator = userId ? `conta:${userId}` : `ip:${ipCliente}`
    enforceRateLimit(
      [[`ai:respiro:${ator}`, AI_RATE_RULES.respiro]],
      'Aguarde alguns segundos entre uma geração e outra.',
    )
    if (userId) {
      enforceRateLimit(
        [[`ai:hora:${ator}`, AI_RATE_RULES.perUser]],
        'Muitas gerações nesta hora. Faça uma pausa e tente de novo daqui a pouco.',
      )
    }
    const quem: QuemGera = userId ? plan : 'anonimo'
    const chaveDoDia = `ai:dia:${ator}`
    const regraDia = regraDoDia(quem)
    enforceRateLimit([[chaveDoDia, regraDia]], (key, rule) =>
      mensagemDoDia(quem, rule.max, proximaVaga(key, rule)),
    )

    // 4. O guarda-chuva das chaves: a plataforma inteira, por hora. Vem DEPOIS dos
    //    tetos individuais para uma pessoa exagerando não consumir o global de
    //    todo mundo — e a mensagem é outra, porque a culpa não é de quem clicou.
    enforceRateLimit(
      [['ai:global', AI_RATE_RULES.global]],
      'A IA está com muita procura agora. Tente de novo em alguns minutos — ou comece por um modelo pronto.',
    )

    const resultado = await this.ai.generate({ ...dto, kind: kind as GenerateDto['kind'], plan })
    // A tela mostra quanto resta: quem vê "restam 3 de 15" não descobre o limite
    // pelo erro.
    return { ...resultado, limite: { restantesHoje: restantes(chaveDoDia, regraDia), tetoHoje: regraDia.max } }
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

/**
 * O 429 do teto diário. Diz o teto, QUANDO a vaga abre (janela de 24 h, não dia
 * do calendário) e o que dá para fazer enquanto isso. A menção a limite maior é
 * informação, não chamada para contratar: nada de urgência nem link.
 */
export function mensagemDoDia(quem: QuemGera, teto: number, vaga: number | null, agora = Date.now()): string {
  const quando = vaga ? ` Você poderá gerar de novo ${quandoAbre(vaga, agora)}.` : ''
  const maior =
    quem === 'anonimo'
      ? ' Com uma conta, o limite é maior.'
      : quem === 'free'
        ? ' Nos planos pagos, o limite diário é maior.'
        : quem === 'pro'
          ? ' No Max, o limite diário é maior.'
          : ''
  return `Você usou as ${teto} gerações de IA das últimas 24 horas.${quando} Enquanto isso, dá para editar o texto à mão.${maior}`
}

/** "às 14:32" ou "amanhã às 14:32", no horário de Brasília, arredondado PARA CIMA. */
function quandoAbre(vaga: number, agora: number): string {
  const tz = { timeZone: 'America/Sao_Paulo' } as const
  // Arredondar para baixo prometeria uma vaga que ainda não abriu.
  const minuto = Math.ceil(vaga / 60_000) * 60_000
  const hora = new Date(minuto).toLocaleTimeString('pt-BR', { ...tz, hour: '2-digit', minute: '2-digit' })
  const dia = (t: number) => new Date(t).toLocaleDateString('pt-BR', tz)
  return dia(minuto) === dia(agora) ? `às ${hora}` : `amanhã às ${hora}`
}
