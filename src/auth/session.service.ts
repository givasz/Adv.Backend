// Quem está falando com a API — e se essa sessão ainda vale.
//
// O desenho em uma frase: o cookie HttpOnly leva um segredo aleatório, o
// armazenamento (Postgres ou Redis, ver session-store.ts) guarda o hash dele, e
// só a existência dessa linha faz a sessão valer. Apagar a linha derruba o cookie
// na hora, mesmo que alguém tenha uma cópia — é o que permite cumprir o "sair".
//
// Três coisas acontecem aqui, todas no mesmo ponto de passagem:
//
//   1. Validação automática. Toda rota autenticada chama `requireUser(req)`, e é
//      lá dentro que a sessão é conferida. Não há como esquecer.
//   2. Renovação deslizante. Enquanto a pessoa usa, o prazo é empurrado para a
//      frente — mas só quando já passou metade dele, para não gravar no banco a
//      cada clique. Uma sessão ativa custa ~1 escrita a cada 15 dias.
//   3. CSRF. Como agora quem carrega a credencial é o cookie (que o navegador
//      manda sozinho), todo método que escreve exige o token da sessão num
//      cabeçalho. Ver csrf.ts.
//
// Custo por requisição autenticada: uma leitura por chave primária, e nem isso na
// maior parte das vezes — um cache curto em memória absorve a rajada de chamadas
// que uma única tela do painel dispara.

import { Inject, Injectable, UnauthorizedException } from '@nestjs/common'
import { randomBytes } from 'node:crypto'
import { CSRF_COOKIE, SESSION_COOKIE } from './cookies'
import { assertCsrf, csrfTokenFor } from './csrf'
import { authDe, type AuthContext, type RequisicaoComAuth } from './session-context'
import { SESSION_STORE, type RegistroSessao, type SessionStore } from './session-store'
import { credencialConfere, duracaoSessao, lerCookie, montarCookie, novaCredencial } from './user-auth'

/** O que uma requisição autenticada sabe sobre quem a mandou. */
export interface SessaoAtiva {
  userId: string
  sessionId: string
  /** epoch ms do vencimento por inatividade (já contando a renovação). */
  expiresAt: number
  remember: boolean
}

/** O que o front recebe ao entrar: prazo e token anti-CSRF. Nunca a credencial. */
export interface SessaoAberta {
  expiresAt: number
  csrfToken: string
  remember: boolean
}

// Cache de sessões validadas. Existe por causa da VPS: abrir o painel dispara
// meia dúzia de chamadas em paralelo, e sem isto cada uma vira uma consulta.
//
// ⚠️ O cache é DESTE processo. Com um único processo (o pm2 daqui roda em modo
// fork) revogar é imediato, porque quem apaga a sessão também limpa o cache. Com
// vários processos, uma sessão encerrada pode sobreviver alguns segundos nos
// outros — nesse cenário use SESSION_STORE=redis e AUTH_SESSION_CACHE_MS=0.
function cacheMsDoAmbiente(): number {
  const n = Number(process.env.AUTH_SESSION_CACHE_MS)
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 60_000) : 15_000
}
const CACHE_MAX = 5_000

interface EntradaCache {
  registro: RegistroSessao
  ate: number
}

@Injectable()
export class SessionService {
  private readonly cache = new Map<string, EntradaCache>()
  // Lido no construtor (e não no topo do módulo) para que ligar/desligar o cache
  // seja possível sem recarregar o processo — os testes dependem disso.
  private readonly cacheMs = cacheMsDoAmbiente()

  constructor(@Inject(SESSION_STORE) private readonly store: SessionStore) {}

  // ---- Abrir ---------------------------------------------------------------

  /**
   * Abre uma sessão para o usuário e grava os cookies na resposta.
   *
   * O id é sorteado aqui (16 bytes) em vez de vir do banco: assim o cookie é
   * montado antes da escrita, e o id não é um contador nem um cuid — nada nele
   * dá pistas sobre quantas sessões existem ou quando foram criadas.
   */
  async abrir(req: RequisicaoComAuth, userId: string, lembrar: boolean): Promise<SessaoAberta> {
    const auth = authDe(req)
    const { idleMs, absolutoMs, persistente } = duracaoSessao(lembrar)

    // Higiene barata: as sessões vencidas deste usuário saem no login seguinte.
    // Sem isto a tabela só cresce, e sessão vencida é dado guardado à toa.
    await this.store.limparVencidas(userId).catch(() => undefined)

    const id = randomBytes(16).toString('hex')
    const { secret, hash } = novaCredencial()
    const agora = Date.now()
    const registro: RegistroSessao = {
      id,
      userId,
      tokenHash: hash,
      expiresAt: new Date(agora + idleMs),
      absoluteExpiresAt: new Date(agora + absolutoMs),
      remember: lembrar,
    }
    await this.store.criar(registro)
    this.guardarNoCache(registro)

    const csrfToken = csrfTokenFor(id)
    // Sem "lembrar de mim" o cookie não leva Max-Age: ele morre ao fechar o
    // navegador. Com, ele volta amanhã — que é o pedido central deste sistema.
    const maxAgeMs = persistente ? idleMs : undefined
    auth.setCookie(SESSION_COOKIE, montarCookie(id, secret), { httpOnly: true, maxAgeMs })
    // O token anti-CSRF vai num cookie LEGÍVEL de propósito (é ele que a página
    // devolve no cabeçalho). Ele não autentica nada sozinho.
    auth.setCookie(CSRF_COOKIE, csrfToken, { httpOnly: false, maxAgeMs })

    return { expiresAt: registro.expiresAt.getTime(), csrfToken, remember: lembrar }
  }

  // ---- Ler -----------------------------------------------------------------

  /**
   * Dono da requisição, ou null. Falha FECHADA: cookie estranho, sessão apagada,
   * sessão vencida e banco fora do ar dão todos o mesmo resultado — ninguém.
   *
   * `csrf: false` só para o logout (ver auth.controller.ts).
   */
  async sessaoAtual(req: RequisicaoComAuth, opcoes: { csrf?: boolean } = {}): Promise<SessaoAtiva | null> {
    const auth = authDe(req)
    // Memória por requisição: um controller que pergunta duas vezes lê uma só.
    if (!auth.resolvida) auth.resolvida = this.resolver(auth)
    const sessao = (await auth.resolvida) as SessaoAtiva | null
    if (!sessao) return null

    // A credencial veio de um cookie, e cookie o navegador manda sozinho. Todo
    // método que escreve precisa provar que o pedido partiu da nossa página.
    assertCsrf(
      { method: auth.method, origin: auth.origin, csrfHeader: auth.csrfHeader },
      sessao.sessionId,
      { exigirToken: opcoes.csrf !== false },
    )
    return sessao
  }

  /** Só o id do dono, ou null. */
  async userIdFrom(req: RequisicaoComAuth, opcoes: { csrf?: boolean } = {}): Promise<string | null> {
    return (await this.sessaoAtual(req, opcoes))?.userId ?? null
  }

  /** Como `userIdFrom`, mas exige sessão: sem ela, 401. */
  async requireUser(req: RequisicaoComAuth, mensagem = 'Entre na sua conta.'): Promise<string> {
    const userId = await this.userIdFrom(req)
    if (!userId) throw new UnauthorizedException(mensagem)
    return userId
  }

  /** Token anti-CSRF da sessão atual — o front o devolve no cabeçalho. */
  csrfDe(sessao: SessaoAtiva): string {
    return csrfTokenFor(sessao.sessionId)
  }

  // ---- Encerrar ------------------------------------------------------------

  /**
   * Encerra a sessão DESTE aparelho e apaga os cookies.
   *
   * Nunca lança: sair é uma intenção, não um pedido que possa falhar. Cookie
   * ausente ou inválido → só limpa o navegador e segue.
   */
  async encerrar(req: RequisicaoComAuth): Promise<string | null> {
    const auth = authDe(req)
    const valor = lerCookie(auth.cookie(SESSION_COOKIE))
    let userId: string | null = null
    if (valor) {
      const registro = await this.store.buscar(valor.sessionId).catch(() => null)
      // Só encerra se a credencial confere: sem isso, quem adivinhasse um id de
      // sessão derrubaria a sessão alheia de graça.
      if (registro && credencialConfere(valor.secret, registro.tokenHash)) {
        userId = registro.userId
        await this.store.apagar(valor.sessionId).catch(() => undefined)
      }
      this.cache.delete(valor.sessionId)
    }
    auth.clearCookie(SESSION_COOKIE, { httpOnly: true })
    auth.clearCookie(CSRF_COOKIE, { httpOnly: false })
    return userId
  }

  /** Encerra TODAS as sessões do usuário (aparelho perdido, senha trocada). */
  async encerrarTodas(userId: string, req?: RequisicaoComAuth): Promise<number> {
    const quantas = await this.store.apagarDoUsuario(userId)
    for (const [id, e] of this.cache) if (e.registro.userId === userId) this.cache.delete(id)
    if (req) {
      const auth = authDe(req)
      auth.clearCookie(SESSION_COOKIE, { httpOnly: true })
      auth.clearCookie(CSRF_COOKIE, { httpOnly: false })
    }
    return quantas
  }

  /** Quantas sessões o usuário tem abertas agora (mostrado no painel da conta). */
  async contarAtivas(userId: string): Promise<number> {
    return this.store.contarAtivas(userId)
  }

  // ---- Interno -------------------------------------------------------------

  private guardarNoCache(registro: RegistroSessao): void {
    if (!this.cacheMs) return
    // Teto simples de memória: passou do limite, esvazia. O custo de reconstruir
    // é uma leitura por sessão, e isso só acontece sob tráfego atípico.
    if (this.cache.size >= CACHE_MAX) this.cache.clear()
    this.cache.set(registro.id, { registro, ate: Date.now() + this.cacheMs })
  }

  private async carregar(sessionId: string): Promise<RegistroSessao | null> {
    const emCache = this.cache.get(sessionId)
    if (emCache && emCache.ate > Date.now()) return emCache.registro
    const registro = await this.store.buscar(sessionId)
    if (registro) this.guardarNoCache(registro)
    else this.cache.delete(sessionId)
    return registro
  }

  /** Validação de verdade. Devolve a sessão viva ou null. */
  private async resolver(auth: AuthContext): Promise<SessaoAtiva | null> {
    const valor = lerCookie(auth.cookie(SESSION_COOKIE))
    if (!valor) return null
    try {
      const registro = await this.carregar(valor.sessionId)
      if (!registro) return null
      if (!credencialConfere(valor.secret, registro.tokenHash)) return null

      const agora = Date.now()
      const absoluto = registro.absoluteExpiresAt.getTime()
      if (registro.expiresAt.getTime() <= agora || absoluto <= agora) return null

      const expiresAt = await this.talvezRenovar(auth, registro, agora, absoluto)
      return {
        userId: registro.userId,
        sessionId: registro.id,
        expiresAt,
        remember: registro.remember,
      }
    } catch {
      return null
    }
  }

  /**
   * Renovação deslizante — a sessão de quem está usando não vence embaixo dela.
   *
   * Só grava quando já se passou METADE do prazo. É o que separa "renovar" de
   * "escrever no banco a cada requisição": com 30 dias de prazo, uma pessoa que
   * entra todo dia gera uma escrita a cada 15 dias. O teto absoluto continua de
   * pé — renovar empurra o vencimento por inatividade, nunca o limite da sessão.
   */
  private async talvezRenovar(
    auth: AuthContext,
    registro: RegistroSessao,
    agora: number,
    absoluto: number,
  ): Promise<number> {
    const atual = registro.expiresAt.getTime()
    const { idleMs, persistente } = duracaoSessao(registro.remember)
    if (atual - agora > idleMs / 2) return atual

    const novo = Math.min(agora + idleMs, absoluto)
    if (novo <= atual) return atual

    const atualizado: RegistroSessao = { ...registro, expiresAt: new Date(novo) }
    try {
      await this.store.renovar(registro.id, atualizado.expiresAt)
    } catch {
      return atual // renovar é conforto, não requisito: a sessão segue valendo
    }
    this.guardarNoCache(atualizado)

    // O cookie também precisa esticar, senão o navegador o descarta no prazo
    // antigo e a sessão "renovada" morreria no cliente. Só faz sentido quando o
    // cookie é persistente; sem "lembrar de mim" ele vive enquanto a janela viver.
    if (persistente) {
      const valor = lerCookie(auth.cookie(SESSION_COOKIE))
      if (valor) {
        auth.setCookie(SESSION_COOKIE, montarCookie(valor.sessionId, valor.secret), {
          httpOnly: true,
          maxAgeMs: idleMs,
        })
        auth.setCookie(CSRF_COOKIE, csrfTokenFor(registro.id), {
          httpOnly: false,
          maxAgeMs: idleMs,
        })
      }
    }
    return novo
  }
}
