// Configuração de segredos — conferida no BOOT, não no primeiro uso.
//
// O motivo: os fallbacks de desenvolvimento ("dev-admin-123", "dev-user-secret")
// existem para o `npm run start:dev` subir sem .env. Em produção eles são uma
// porta aberta — quem conhece o repositório assina o próprio token de sessão e
// entra como qualquer advogado, ou como admin. Então em produção a API RECUSA
// subir enquanto os segredos não forem reais (fail closed).

export const IS_PROD = process.env.NODE_ENV === 'production'

/** Segredos de desenvolvimento e placeholders do .env.example — proibidos em produção. */
const PROIBIDOS = new Set(
  [
    'dev-admin-123',
    'dev-admin-secret',
    'dev-user-secret',
    'dev-admin-token',
    'troque-este-token',
    'troque-esta-senha',
    'troque-por-um-segredo-longo-aleatorio',
    'troque-por-outro-segredo-longo-aleatorio',
    'admin',
    'senha',
    'password',
    'changeme',
    'secret',
  ].map((s) => s.toLowerCase()),
)

/** Tamanho mínimo de um segredo de assinatura (HMAC) em produção. */
const SEGREDO_MIN = 24
/** Tamanho mínimo da senha do painel admin em produção. */
const SENHA_ADMIN_MIN = 12

function fraco(valor: string | undefined): boolean {
  const v = (valor ?? '').trim()
  return !v || PROIBIDOS.has(v.toLowerCase())
}

/**
 * Confere os segredos obrigatórios. Em produção, lança e derruba o boot listando
 * exatamente o que falta — erro de deploy é muito mais barato que uma sessão
 * forjável em silêncio. Fora de produção, só avisa.
 */
export function assertSecureConfig(warn: (msg: string) => void = console.warn): void {
  const problemas: string[] = []

  const authSecret = process.env.AUTH_SESSION_SECRET || process.env.ADMIN_SESSION_SECRET
  if (fraco(authSecret) || (authSecret ?? '').length < SEGREDO_MIN) {
    problemas.push(
      `AUTH_SESSION_SECRET ausente, padrão ou curto (mínimo ${SEGREDO_MIN} caracteres aleatórios).`,
    )
  }
  if (
    fraco(process.env.ADMIN_SESSION_SECRET) ||
    (process.env.ADMIN_SESSION_SECRET ?? '').length < SEGREDO_MIN
  ) {
    problemas.push(
      `ADMIN_SESSION_SECRET ausente, padrão ou curto (mínimo ${SEGREDO_MIN} caracteres aleatórios).`,
    )
  }
  if (
    fraco(process.env.ADMIN_PASSWORD) ||
    (process.env.ADMIN_PASSWORD ?? '').length < SENHA_ADMIN_MIN
  ) {
    problemas.push(`ADMIN_PASSWORD ausente, padrão ou curta (mínimo ${SENHA_ADMIN_MIN} caracteres).`)
  }
  // O token estático legado é um "bearer eterno": se existir, precisa ser forte.
  if (process.env.ADMIN_TOKEN && (fraco(process.env.ADMIN_TOKEN) || process.env.ADMIN_TOKEN.length < SEGREDO_MIN)) {
    problemas.push(
      `ADMIN_TOKEN definido com valor padrão ou curto — remova-o ou use ${SEGREDO_MIN}+ caracteres aleatórios.`,
    )
  }
  if (!process.env.FRONTEND_ORIGIN) {
    problemas.push('FRONTEND_ORIGIN ausente — o CORS cairia no localhost de desenvolvimento.')
  }

  if (!problemas.length) return

  const texto = problemas.map((p) => `  • ${p}`).join('\n')
  if (IS_PROD) {
    throw new Error(
      `Configuração de segurança inválida — a API não sobe assim:\n${texto}\n` +
        'Gere segredos com: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
    )
  }
  warn(`[segurança] Usando padrões de desenvolvimento:\n${texto}`)
}

/**
 * Segredo de assinatura, com comportamento diferente por ambiente:
 *
 *   • produção — só aceita valor real. Se nenhum candidato servir, LANÇA: melhor
 *     invalidar todas as sessões do que assinar com um segredo que está no
 *     repositório e deixar qualquer pessoa forjar a sua.
 *   • desenvolvimento — devolve o que estiver no .env (mesmo o valor de exemplo)
 *     e, na falta dele, o `devFallback`. Trocar isso em silêncio faria o login
 *     local parar de funcionar sem explicação.
 */
export function requireSecret(candidatos: (string | undefined)[], devFallback: string): string {
  for (const c of candidatos) {
    const v = (c ?? '').trim()
    if (!v) continue
    if (!IS_PROD) return c as string
    if (!PROIBIDOS.has(v.toLowerCase())) return c as string
  }
  if (IS_PROD) throw new Error('Segredo de sessão ausente ou inseguro.')
  return devFallback
}
