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

/**
 * Aplica várias regras de uma vez; lança 429 na primeira que estourar.
 * A mensagem pode ser uma função da regra que estourou — é o que deixa dizer
 * "poderá gerar de novo às 14:32" em vez de um "aguarde" sem prazo.
 */
export function enforceRateLimit(
  entradas: [key: string, rule: Rule][],
  mensagem: string | ((key: string, rule: Rule) => string) = 'Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente novamente.',
): void {
  for (const [key, rule] of entradas) {
    if (!checkRateLimit(key, rule)) {
      // O estouro é o sinal mais barato de ataque em curso — vale a linha de log.
      logSecurityEvent({ event: 'rate_limited', resource: key, result: 'negado' })
      throw new HttpException(
        typeof mensagem === 'function' ? mensagem(key, rule) : mensagem,
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }
  }
}

/** Quantos acessos ainda cabem na janela. Só olha: não registra nada. */
export function restantes(key: string, rule: Rule): number {
  const cutoff = Date.now() - rule.windowMs
  const recent = (hits.get(key) ?? []).filter((t) => t > cutoff)
  return Math.max(0, rule.max - recent.length)
}

/** Quando abre a próxima vaga (epoch ms), ou null se já existe vaga. Só olha. */
export function proximaVaga(key: string, rule: Rule): number | null {
  const cutoff = Date.now() - rule.windowMs
  const recent = (hits.get(key) ?? []).filter((t) => t > cutoff)
  if (recent.length < rule.max) return null
  // Os acessos entram em ordem; a vaga abre quando o mais antigo dos que
  // excedem sair da janela.
  return recent[recent.length - rule.max] + rule.windowMs
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
// Alturas de teto (04/09/2026; apertadas em 12/09/2026):
//
//   • RESPIRO — uma geração por vez: duas no mesmo punhado de segundos são o
//     clique duplo ou o "gerar de novo" sem ler o que veio;
//   • por MINUTO/HORA — segura o laço de terminal e a rajada;
//   • por DIA, conforme o PLANO — segura o uso legítimo mas exagerado. Cada
//     pedido pode virar até quatro chamadas ao provedor (geração + três
//     reparos), e a cota do tier grátis é de TODOS. Era 80 por dia para
//     qualquer conta: o suficiente para uma pessoa gerar a bio sem parar a tarde
//     inteira. Um perfil se escreve com meia dúzia de gerações; o teto do Free
//     cobre isso com folga, e o de quem paga cresce com o plano;
//   • por IP no dia, somando TODO mundo — a fábrica de contas grátis;
//   • GLOBAL por hora — o guarda-chuva das chaves: seja quem for e de onde for,
//     a plataforma inteira não passa disto por hora. É o teto que impede que
//     um dia de procura acima do normal derrube o "Gerar com IA" de todo mundo
//     à tarde. Ajustável sem deploy por AI_TETO_GLOBAL_HORA.
//
// É janela deslizante de 24 h, não dia do calendário — por isso a tela fala em
// "últimas 24 horas" e a mensagem de estouro diz a hora em que a vaga abre.
// A janela diária pede que pruneExpired abaixo enxergue 24 h, não 1 h.
const DIA = 24 * 60 * 60 * 1000
const HORA = 60 * 60 * 1000
export const AI_RATE_RULES = {
  // Endereço — com ou sem conta. O de hora é folgado porque um escritório inteiro
  // pode sair pelo mesmo IP.
  perIpBurst: { windowMs: 60 * 1000, max: 6 } as Rule,
  perIp: { windowMs: HORA, max: 40 } as Rule,
  perIpDayTotal: { windowMs: DIA, max: 120 } as Rule,
  // Quem gera (conta; sem conta, o IP). O respiro é 4 s e a tela espera 5: a
  // diferença absorve a latência, para o botão nunca liberar antes do servidor.
  respiro: { windowMs: 4_000, max: 1 } as Rule,
  perUser: { windowMs: HORA, max: 20 } as Rule,
  global: { windowMs: HORA, max: tetoGlobalPorHora() } as Rule,
}

/** Quem pede: o plano vigente de uma conta, ou ninguém logado. */
export type QuemGera = 'anonimo' | 'free' | 'pro' | 'premium'

/** Gerações de IA por 24 horas. Quem decide o plano é o servidor (planoVigente). */
export const AI_GERACOES_POR_DIA: Record<QuemGera, number> = {
  anonimo: 8,
  free: 15,
  pro: 30,
  premium: 60,
}

export function regraDoDia(quem: QuemGera): Rule {
  return { windowMs: DIA, max: AI_GERACOES_POR_DIA[quem] }
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

// Correio — pedir um link por e-mail e usar o link.
//
// Todo pedido aqui faz a plataforma MANDAR UM E-MAIL para um endereço digitado
// por quem pede. Sem teto, a rota vira um jeito de encher a caixa de alguém com
// mensagens assinadas por nós (e de queimar a reputação do domínio, que é o que
// faz os avisos de verdade caírem no spam).
//
// O teto por e-mail usa a impressão digital, nunca o endereço — a chave vai para
// o log quando estoura (ver enforceRateLimit).
export const CORREIO_RATE_RULES = {
  esqueciPorIp: { windowMs: 60 * 60 * 1000, max: 10 } as Rule,
  // Cinco, e não um: quem espera o e-mail e não vê pede de novo — e cada pedido
  // mata o link anterior. Travar no primeiro deixaria a pessoa sem link nenhum.
  esqueciPorEmail: { windowMs: 60 * 60 * 1000, max: 5 } as Rule,
  // Usar o link: o token tem 256 bits, então isto não protege o token — protege
  // o scrypt da senha nova, que custa CPU a cada tentativa.
  redefinirPorIp: { windowMs: 15 * 60 * 1000, max: 20 } as Rule,
  confirmarPorIp: { windowMs: 15 * 60 * 1000, max: 30 } as Rule,
  reenviarPorConta: { windowMs: 60 * 60 * 1000, max: 3 } as Rule,
}
