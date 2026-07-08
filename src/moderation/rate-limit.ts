// Rate limiter simples em memória (janela deslizante) para o endpoint público
// de denúncia. Suficiente para uma instância (Render). Em cenário multi-instância,
// trocar por um store compartilhado (ex.: Redis).

interface Rule {
  windowMs: number
  max: number
}

const hits = new Map<string, number[]>()
// Backstop: evita crescimento ilimitado do Map em ataques com muitos IPs.
const MAX_KEYS = 10_000

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

// Remove chaves cujos acessos já expiraram (janela máxima considerada: 1h).
function pruneExpired(now: number) {
  const horizon = now - 60 * 60 * 1000
  for (const [k, arr] of hits) {
    if (arr.every((t) => t <= horizon)) hits.delete(k)
  }
}

// Regras aplicadas à denúncia pública.
export const REPORT_RATE_RULES = {
  // No máximo 5 denúncias por IP a cada 10 minutos (qualquer perfil).
  perIp: { windowMs: 10 * 60 * 1000, max: 5 } as Rule,
  // No máximo 3 denúncias do mesmo IP contra o MESMO perfil por hora
  // (evita "brigada" de denúncias repetidas contra um alvo).
  perIpProfile: { windowMs: 60 * 60 * 1000, max: 3 } as Rule,
}
