// Peças soltas da autenticação do painel: onde os cookies valem, quanto dura a
// sessão, e as duas credenciais que NÃO vêm do banco.
//
// Quem monta sessão, confere permissão e registra ação é o AdminService — este
// arquivo só guarda o que ele (e os testes) precisam compartilhar sem arrastar o
// Prisma junto. A divisão existe porque estas peças são conferidas no boot e em
// script de linha de comando, onde não há injeção de dependência nenhuma.
//
// Duas diferenças deliberadas em relação à sessão do advogado:
//
//   • **O cookie vale só em `/api/admin`.** Todas as rotas do painel moram lá, e
//     assim o cookie do admin não viaja junto de nenhuma visita a perfil público.
//   • **A sessão é mais curta** (8 horas, teto de 24), porque este é o painel que
//     decide o que sai do ar.
//
// Configuração (env):
//   ADMIN_USERNAME        usuário da credencial de emergência (default: "admin")
//   ADMIN_PASSWORD        senha dela (fallback: ADMIN_TOKEN, depois "dev-admin-123")
//   ADMIN_SESSION_SECRET  segredo p/ derivar o token anti-CSRF
//   ADMIN_SESSION_HOURS   duração da sessão do painel (padrão 8, teto 24)
//
// ⚠️ A credencial de emergência só entra enquanto NÃO existir nenhum
// administrador cadastrado — ela é a porta pela qual o primeiro nasce. Ver
// admin.service.ts e `npm run admin:create`.

import { timingSafeEqual } from 'node:crypto'
import { CSRF_COOKIE } from '../auth/cookies'
import { IS_PROD, requireSecret } from '../security/config'

/** Nome base do cookie da sessão do painel. */
export const ADMIN_COOKIE = 'advocme_admin'
/** Nome base do cookie do token anti-CSRF do painel. */
export const ADMIN_CSRF_COOKIE = `${CSRF_COOKIE}_admin`
/** Onde os dois valem. Todas as rotas do painel estão sob este caminho. */
export const ADMIN_COOKIE_PATH = '/api/admin'

const HORA = 60 * 60 * 1000

export interface DuracaoAdmin {
  /** Vence por inatividade; empurrado enquanto a pessoa usa o painel. */
  idleMs: number
  /** Teto absoluto: nem renovando a sessão passa daqui. */
  absolutoMs: number
}

/**
 * Quanto dura uma sessão do painel.
 *
 * O teto absoluto existe pelo mesmo motivo da sessão do advogado: só renovar não
 * basta — uma sessão usada todo dia viveria para sempre, e um cookie roubado
 * junto com ela. Aqui ele é o dobro do prazo ocioso, no máximo 24 horas: um turno
 * de trabalho, não uma semana.
 */
export function duracaoSessaoAdmin(): DuracaoAdmin {
  const n = Number(process.env.ADMIN_SESSION_HOURS)
  const horas = Number.isFinite(n) && n > 0 ? Math.min(n, 24) : 8
  const idleMs = horas * HORA
  return { idleMs, absolutoMs: Math.min(24 * HORA, Math.max(idleMs, idleMs * 2)) }
}

/** Usuário da credencial de emergência. */
export function adminUsername(): string {
  return process.env.ADMIN_USERNAME || 'admin'
}

/** Identificação da credencial de emergência nos registros. */
export function adminLabel(): string {
  return adminUsername()
}

function adminPassword(): string {
  // Em produção não existe senha padrão: sem ADMIN_PASSWORD, nenhuma senha entra
  // (requireSecret lança) — o painel fica trancado em vez de aberto com
  // "dev-admin-123". Ver security/config.ts.
  return requireSecret([process.env.ADMIN_PASSWORD, process.env.ADMIN_TOKEN], 'dev-admin-123')
}

/** Comparação de strings resistente a timing attacks. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Valida a credencial de emergência. As duas comparações rodam SEMPRE (nada de
 * `&&` curto-circuitando a segunda): assim o tempo de resposta não diz se o
 * usuário existe. Falha fechada se o segredo não estiver configurado.
 */
export function verifyCredentials(username?: string, password?: string): boolean {
  try {
    const userOk = safeEqual((username ?? '').trim(), adminUsername())
    const passOk = safeEqual(password ?? '', adminPassword())
    return userOk && passOk
  } catch {
    return false
  }
}

/**
 * Token estático legado (`x-admin-token = ADMIN_TOKEN`), para script e curl.
 *
 * **Em produção, não vale mais.** Era um bearer sem expiração que, por desenho,
 * pulava a checagem de CSRF — um portão lateral em todo o resto do trabalho de
 * segurança do painel, impossível de revogar sem reiniciar a API com outro .env.
 * Fora de produção ele continua aceito (é o que faz `curl` funcionar na máquina
 * de quem desenvolve) e, mesmo lá, entra como `readonly`: não decide nada.
 */
export function tokenEstaticoConfere(adminToken?: string): boolean {
  if (IS_PROD) return false
  const staticToken = process.env.ADMIN_TOKEN
  if (!staticToken || !adminToken) return false
  return safeEqual(adminToken, staticToken)
}
