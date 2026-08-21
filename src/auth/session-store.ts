// Onde as sessões moram.
//
// A camada existe para que a resposta a "banco ou Redis?" seja uma variável de
// ambiente, e não uma refatoração. Hoje o padrão é o Postgres que já está na VPS
// — uma dependência a menos para instalar, monitorar e reiniciar, e o volume de
// sessões de uma plataforma deste tamanho cabe folgado numa tabela indexada.
// Quando houver mais de um processo servindo a API (pm2 em cluster, uma segunda
// máquina), o Redis passa a valer a pena: ele centraliza o estado e o cache em
// memória de cada processo deixa de ser um risco de sessão revogada que sobrevive
// alguns segundos (ver session.service.ts).
//
//   SESSION_STORE=prisma   (padrão)
//   SESSION_STORE=redis    exige REDIS_URL e o pacote `ioredis` instalado
//
// Quem chama não sabe de nada disso: usa a interface abaixo.

import { Logger } from '@nestjs/common'
import type { PrismaService } from '../prisma/prisma.service'

/** Token de injeção — quem depende de sessão pede a interface, não a implementação. */
export const SESSION_STORE = Symbol('SESSION_STORE')

export interface RegistroSessao {
  id: string
  userId: string
  /** SHA-256 do segredo que está no cookie. O segredo em si não é guardado. */
  tokenHash: string
  /** Vence por inatividade; renovado enquanto a pessoa usa. */
  expiresAt: Date
  /** Teto absoluto — nem renovando a sessão passa daqui. */
  absoluteExpiresAt: Date
  /** Veio de um login com "lembrar de mim"? Define a duração e o tipo de cookie. */
  remember: boolean
}

export interface SessionStore {
  criar(registro: RegistroSessao): Promise<void>
  buscar(id: string): Promise<RegistroSessao | null>
  /** Empurra o vencimento por inatividade (renovação deslizante). */
  renovar(id: string, expiresAt: Date): Promise<void>
  apagar(id: string): Promise<void>
  /** Encerra todas as sessões da conta. Devolve quantas eram. */
  apagarDoUsuario(userId: string): Promise<number>
  contarAtivas(userId: string): Promise<number>
  /** Higiene: tira do caminho o que já venceu. Nunca pode derrubar o login. */
  limparVencidas(userId: string): Promise<void>
}

// ---- Postgres (Prisma) ------------------------------------------------------

export class PrismaSessionStore implements SessionStore {
  constructor(private readonly prisma: PrismaService) {}

  async criar(registro: RegistroSessao): Promise<void> {
    await this.prisma.session.create({ data: registro })
  }

  async buscar(id: string): Promise<RegistroSessao | null> {
    const linha = await this.prisma.session.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        tokenHash: true,
        expiresAt: true,
        absoluteExpiresAt: true,
        remember: true,
      },
    })
    return linha ?? null
  }

  async renovar(id: string, expiresAt: Date): Promise<void> {
    // updateMany em vez de update: se a sessão foi apagada no meio do caminho
    // (outro aparelho encerrou tudo), o update explodiria com P2025 e derrubaria
    // uma requisição que estava indo bem.
    await this.prisma.session.updateMany({ where: { id }, data: { expiresAt } })
  }

  async apagar(id: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { id } })
  }

  async apagarDoUsuario(userId: string): Promise<number> {
    const { count } = await this.prisma.session.deleteMany({ where: { userId } })
    return count
  }

  async contarAtivas(userId: string): Promise<number> {
    return this.prisma.session.count({ where: { userId, expiresAt: { gt: new Date() } } })
  }

  async limparVencidas(userId: string): Promise<void> {
    await this.prisma.session
      .deleteMany({ where: { userId, expiresAt: { lt: new Date() } } })
      .catch(() => undefined)
  }
}

// ---- Redis ------------------------------------------------------------------

/**
 * O mínimo de um cliente Redis que este código usa. Tipar assim (em vez de
 * depender do tipo do `ioredis`) mantém o pacote opcional: quem não usa Redis não
 * precisa instalá-lo, e o build não quebra por falta dele.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>
  set(key: string, value: string, modo: 'PX', ttl: number): Promise<unknown>
  pexpire(key: string, ms: number): Promise<unknown>
  del(...keys: string[]): Promise<unknown>
  sadd(key: string, ...members: string[]): Promise<unknown>
  srem(key: string, ...members: string[]): Promise<unknown>
  smembers(key: string): Promise<string[]>
  mget(...keys: string[]): Promise<(string | null)[]>
}

const PREFIXO = 'advocme:sess:'
const chaveSessao = (id: string) => `${PREFIXO}${id}`
const chaveUsuario = (userId: string) => `${PREFIXO}u:${userId}`

interface RegistroSerializado {
  id: string
  userId: string
  tokenHash: string
  expiresAt: number
  absoluteExpiresAt: number
  remember: boolean
}

function desserializar(json: string | null): RegistroSessao | null {
  if (!json) return null
  try {
    const r = JSON.parse(json) as RegistroSerializado
    if (!r?.id || !r.userId || !r.tokenHash) return null
    return {
      id: r.id,
      userId: r.userId,
      tokenHash: r.tokenHash,
      expiresAt: new Date(r.expiresAt),
      absoluteExpiresAt: new Date(r.absoluteExpiresAt),
      remember: !!r.remember,
    }
  } catch {
    return null
  }
}

export class RedisSessionStore implements SessionStore {
  constructor(private readonly redis: RedisLike) {}

  private ttl(registro: RegistroSessao): number {
    // O Redis expira sozinho no teto absoluto; o vencimento por inatividade é
    // conferido na leitura. Assim uma renovação não precisa reescrever o TTL para
    // além do que a sessão pode viver.
    return Math.max(1000, registro.absoluteExpiresAt.getTime() - Date.now())
  }

  async criar(registro: RegistroSessao): Promise<void> {
    const payload: RegistroSerializado = {
      ...registro,
      expiresAt: registro.expiresAt.getTime(),
      absoluteExpiresAt: registro.absoluteExpiresAt.getTime(),
    }
    await this.redis.set(chaveSessao(registro.id), JSON.stringify(payload), 'PX', this.ttl(registro))
    await this.redis.sadd(chaveUsuario(registro.userId), registro.id)
    await this.redis.pexpire(chaveUsuario(registro.userId), this.ttl(registro))
  }

  async buscar(id: string): Promise<RegistroSessao | null> {
    return desserializar(await this.redis.get(chaveSessao(id)))
  }

  async renovar(id: string, expiresAt: Date): Promise<void> {
    const atual = await this.buscar(id)
    if (!atual) return
    await this.criar({ ...atual, expiresAt })
  }

  async apagar(id: string): Promise<void> {
    const atual = await this.buscar(id)
    await this.redis.del(chaveSessao(id))
    if (atual) await this.redis.srem(chaveUsuario(atual.userId), id)
  }

  async apagarDoUsuario(userId: string): Promise<number> {
    const ids = await this.redis.smembers(chaveUsuario(userId))
    if (!ids.length) return 0
    await this.redis.del(...ids.map(chaveSessao), chaveUsuario(userId))
    return ids.length
  }

  async contarAtivas(userId: string): Promise<number> {
    const ids = await this.redis.smembers(chaveUsuario(userId))
    if (!ids.length) return 0
    const valores = await this.redis.mget(...ids.map(chaveSessao))
    const agora = Date.now()
    const mortas: string[] = []
    let vivas = 0
    valores.forEach((v, i) => {
      const r = desserializar(v)
      if (r && r.expiresAt.getTime() > agora) vivas++
      else mortas.push(ids[i]!)
    })
    // O conjunto por usuário não expira item a item; a leitura aproveita para
    // varrer o que sobrou. Sem isso ele cresceria para sempre.
    if (mortas.length) await this.redis.srem(chaveUsuario(userId), ...mortas)
    return vivas
  }

  async limparVencidas(): Promise<void> {
    // O próprio Redis apaga pelo TTL. Nada a fazer.
  }
}

// ---- Escolha ----------------------------------------------------------------

const log = new Logger('SessionStore')

/**
 * Monta o armazenamento configurado. Se o Redis foi pedido mas não dá para usar
 * (pacote ausente, URL errada), CAI no Postgres e avisa — derrubar o boot da API
 * por causa de um cache seria trocar uma degradação por uma queda.
 */
export function criarSessionStore(prisma: PrismaService): SessionStore {
  const escolha = (process.env.SESSION_STORE ?? 'prisma').trim().toLowerCase()
  if (escolha !== 'redis') return new PrismaSessionStore(prisma)

  const url = (process.env.REDIS_URL ?? '').trim()
  if (!url) {
    log.warn('SESSION_STORE=redis sem REDIS_URL — as sessões continuam no Postgres.')
    return new PrismaSessionStore(prisma)
  }
  try {
    // require dinâmico: `ioredis` é dependência OPCIONAL. Import estático faria o
    // build exigir o pacote de quem nunca vai ligar o Redis.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('ioredis')
    const Redis = mod?.default ?? mod
    const cliente = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 }) as RedisLike
    log.log('Sessões no Redis.')
    return new RedisSessionStore(cliente)
  } catch (err) {
    log.warn(
      `Redis indisponível (${err instanceof Error ? err.message : 'erro'}) — ` +
        'as sessões continuam no Postgres. Instale `ioredis` para usar SESSION_STORE=redis.',
    )
    return new PrismaSessionStore(prisma)
  }
}
