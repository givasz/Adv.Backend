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

// Remove chaves cujos acessos já expiraram (janela máxima considerada: 1h).
function pruneExpired(now: number) {
  const horizon = now - 60 * 60 * 1000
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
  // Painel de moderação: uma senha só, então o teto é bem mais apertado.
  adminLoginPerIp: { windowMs: 15 * 60 * 1000, max: 6 } as Rule,
  adminLoginGlobal: { windowMs: 15 * 60 * 1000, max: 40 } as Rule,
}

// Geração de texto por IA: cada chamada custa dinheiro num provedor pago. Sem
// teto, um laço de terminal esvazia o orçamento da conta em minutos.
export const AI_RATE_RULES = {
  perIp: { windowMs: 60 * 60 * 1000, max: 40 } as Rule,
  perIpBurst: { windowMs: 60 * 1000, max: 8 } as Rule,
  perUser: { windowMs: 60 * 60 * 1000, max: 120 } as Rule,
}

// Webhook de cobrança. O teto é FOLGADO de propósito: quem chama é o servidor do
// provedor, sempre do mesmo punhado de IPs, e uma rajada de retentativas legítima
// (que é como todo provedor se recupera de uma indisponibilidade nossa) não pode
// ser barrada — evento barrado é assinatura que para de refletir a realidade.
// O que este teto segura é força bruta contra a assinatura HMAC, não o provedor.
export const BILLING_RATE_RULES = {
  perIp: { windowMs: 60 * 1000, max: 240 } as Rule,
}
