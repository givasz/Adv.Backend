// Rate limiter em memória (janela deslizante). Suficiente para uma instância —
// que é o desenho de hoje (VPS única / Render). Em cenário multi-instância,
// trocar o Map por um store compartilhado (Redis) mantendo esta interface.

import { HttpException, HttpStatus } from '@nestjs/common'
import { logSecurityEvent } from './audit-log'

export interface Rule {
  windowMs: number
  max: number
}

const hits = new Map<string, number[]>()
// Backstop: evita crescimento ilimitado do Map em ataques com muitos IPs.
const MAX_KEYS = 50_000

/**
 * Registra um acesso para `key` e diz se ele é permitido pela regra.
 * Retorna false quando o limite da janela já foi atingido (não registra o excedente).
 */
export function checkRateLimit(key: string, rule: Rule): boolean {
  const now = Date.now()
  const cutoff = now - rule.windowMs
  const recent = (hits.get(key) ?? []).filter((t) => t > cutoff)

  if (recent.length >= rule.max) {
    hits.set(key, recent)
    return false
  }
  recent.push(now)
  hits.set(key, recent)

  if (hits.size > MAX_KEYS) pruneExpired(now)
  return true
}

/** Aplica várias regras de uma vez; lança 429 na primeira que estourar. */
export function enforceRateLimit(
  entradas: [key: string, rule: Rule][],
  mensagem = 'Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente novamente.',
): void {
  for (const [key, rule] of entradas) {
    if (!checkRateLimit(key, rule)) {
      // O estouro é o sinal mais barato de ataque em curso — vale a linha de log.
      logSecurityEvent({ event: 'rate_limited', resource: key, result: 'negado' })
      throw new HttpException(mensagem, HttpStatus.TOO_MANY_REQUESTS)
    }
  }
}

// Remove chaves cujos acessos já expiraram. A janela máxima considerada é 24 h
// (era 1 h): com as regras diárias da IA, podar em 1 h apagaria a contagem do
// dia de quem estivesse quieto há uma hora — justamente sob pressão de memória,
// que é quando um ataque está em curso.
function pruneExpired(now: number) {
  const horizon = now - 24 * 60 * 60 * 1000
  for (const [k, arr] of hits) {
    if (arr.every((t) => t <= horizon)) hits.delete(k)
  }
}

/** Só para os testes: zera o estado entre casos. */
export function resetRateLimits(): void {
  hits.clear()
}

// ---- Regras por área -------------------------------------------------------

// Denúncia pública (anti-spam / anti-brigada).
export const REPORT_RATE_RULES = {
  perIp: { windowMs: 10 * 60 * 1000, max: 5 } as Rule,
  perIpProfile: { windowMs: 60 * 60 * 1000, max: 3 } as Rule,
}

// Entrada de conta. O limite por e-mail é o que segura o ataque de dicionário
// contra UMA conta; o limite por IP segura a varredura de muitas contas.
export const AUTH_RATE_RULES = {
  loginPerIp: { windowMs: 10 * 60 * 1000, max: 20 } as Rule,
  loginPerEmail: { windowMs: 15 * 60 * 1000, max: 8 } as Rule,
  signupPerIp: { windowMs: 60 * 60 * 1000, max: 8 } as Rule,
  // Painel de moderação: o teto é bem mais apertado que o do advogado.
  adminLoginPerIp: { windowMs: 15 * 60 * 1000, max: 6 } as Rule,
  // Por CONTA do painel — o dicionário contra UM administrador, que trocar de IP
  // não resolve. É o teto que faz o trabalho fino, e é o que permitiu afrouxar o
  // global abaixo sem perder proteção.
  adminLoginPerAccount: { windowMs: 15 * 60 * 1000, max: 8 } as Rule,
  // Backstop contra varredura distribuída, e SÓ isso.
  //
  // Era 40. Com 40, qualquer pessoa de fora derrubava o acesso de TODOS os
  // administradores por quinze minutos gastando quarenta requisições — sem
  // conhecer um usuário, sem saber uma senha. Num painel cuja função é tirar
  // conteúdo irregular do ar, esse desligamento remoto era a falha mais barata
  // de explorar que havia aqui. 400 continua sendo um volume que nenhum uso
  // legítimo alcança (são no máximo um punhado de administradores), e agora ele
  // é a última linha, não a primeira.
  adminLoginGlobal: { windowMs: 15 * 60 * 1000, max: 400 } as Rule,
}

// Geração de texto por IA: cada chamada custa dinheiro num provedor pago — ou,
// em produção hoje, custa COTA de um tier grátis, que é ainda mais escassa. Sem
// teto, um laço de terminal esvazia o orçamento da conta em minutos.
//
// Três alturas de teto (04/09/2026):
//
//   • por MINUTO/HORA — segura o laço de terminal e o clique nervoso;
//   • por DIA — segura o uso legítimo mas exagerado: uma pessoa gerando a bio
//     sessenta vezes num dia não é ataque, mas cada pedido pode virar até
//     quatro chamadas ao provedor (geração + três reparos). A cota diária do
//     tier grátis do Gemini se mede em centenas de pedidos, e ela é de TODOS;
//   • GLOBAL por hora — o guarda-chuva das chaves: seja quem for e de onde for,
//     a plataforma inteira não passa disto por hora. É o teto que impede que
//     um dia de procura acima do normal derrube o "Gerar com IA" de todo mundo
//     à tarde. Ajustável sem deploy por AI_TETO_GLOBAL_HORA.
//
// A janela diária pede que pruneExpired abaixo enxergue 24 h, não 1 h.
const DIA = 24 * 60 * 60 * 1000
export const AI_RATE_RULES = {
  perIp: { windowMs: 60 * 60 * 1000, max: 40 } as Rule,
  perIpBurst: { windowMs: 60 * 1000, max: 8 } as Rule,
  perUser: { windowMs: 60 * 60 * 1000, max: 120 } as Rule,
  // Sem conta (Free anônimo) o dia é mais curto: é a porta pública da rota.
  perIpDay: { windowMs: DIA, max: 30 } as Rule,
  perUserDay: { windowMs: DIA, max: 80 } as Rule,
  global: { windowMs: 60 * 60 * 1000, max: tetoGlobalPorHora() } as Rule,
}

/** O teto global por hora, com override pelo .env (número inteiro positivo). */
export function tetoGlobalPorHora(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt((env.AI_TETO_GLOBAL_HORA ?? '').trim(), 10)
  return Number.isFinite(n) && n > 0 ? n : 300
}

// Webhook de cobrança. O teto é FOLGADO de propósito: quem chama é o servidor do
// provedor, sempre do mesmo punhado de IPs, e uma rajada de retentativas legítima
// (que é como todo provedor se recupera de uma indisponibilidade nossa) não pode
// ser barrada — evento barrado é assinatura que para de refletir a realidade.
// O que este teto segura é força bruta contra a assinatura HMAC, não o provedor.
export const BILLING_RATE_RULES = {
  perIp: { windowMs: 60 * 1000, max: 240 } as Rule,
}
