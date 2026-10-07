// Banco em memória para os testes do Programa Advocme Parceiros.
//
// Não é um Prisma: é o pedaço dele que o programa usa, com as três coisas que
// importam para os testes serem honestos —
//
//   • CHAVES ÚNICAS de verdade (P2002), porque é nelas que a idempotência mora;
//   • TRANSAÇÃO que se desfaz quando lança, porque o compare-and-swap do
//     benefício depende de a reivindicação da recompensa voltar atrás;
//   • ESPERA entre operações (cada uma é `await`), para duas confirmações
//     simultâneas se intercalarem de fato — sem isso, o teste de corrida passaria
//     mesmo com o código errado.
//
// Fica fora de `src/` de propósito: nunca entra no build.

type Linha = Record<string, any>
type Tabela = 'profile' | 'user' | 'partnerMembership' | 'partnerReferral' | 'partnerReward' | 'partnerInvite' | 'adminAction'

const UNICOS: Partial<Record<Tabela, string[]>> = {
  profile: ['id', 'userId', 'slug'],
  user: ['id', 'email'],
  partnerMembership: ['id', 'profileId', 'referralCode'],
  partnerReferral: ['id', 'referredUserId'],
  partnerReward: ['id', 'key', 'referralId', 'sourcePaymentId'],
  partnerInvite: ['id', 'email'],
}

const PADROES: Partial<Record<Tabela, () => Linha>> = {
  partnerMembership: () => ({
    status: 'invited',
    benefitUntil: null,
    termsVersion: '',
    termsAcceptedAt: null,
    termsIp: '',
    invitedAt: new Date(),
    activatedAt: null,
    suspendedAt: null,
    endedAt: null,
    benefitReconciledAt: null,
  }),
  partnerReferral: () => ({
    referredUserId: null,
    attributedAt: new Date(),
    convertedAt: null,
    disqualifiedAt: null,
    disqualificationReason: '',
  }),
  partnerReward: () => ({
    referralId: null,
    sourcePaymentId: null,
    sourceBillingEventId: null,
    eligibleAt: null,
    confirmedAt: null,
    revokedAt: null,
    reason: '',
  }),
}

const PREFIXO: Record<Tabela, string> = {
  profile: 'prof',
  user: 'user',
  partnerMembership: 'memb',
  partnerReferral: 'refe',
  partnerReward: 'rewa',
  partnerInvite: 'conv',
  adminAction: 'acao',
}

export class ErroUnico extends Error {
  code = 'P2002'
}

const espera = () => new Promise<void>((r) => setImmediate(r))

export function bancoFalso() {
  const t: Record<Tabela, Linha[]> = {
    profile: [],
    user: [],
    partnerMembership: [],
    partnerReferral: [],
    partnerReward: [],
    partnerInvite: [],
    adminAction: [],
  }
  let seq = 0
  const novoId = (tabela: Tabela) => `${PREFIXO[tabela]}${String(++seq).padStart(8, '0')}`

  // Relação → como chegar ao outro lado, e em que tabela ele mora.
  const REL: Record<string, Record<string, { tabela: Tabela; achar: (l: Linha) => Linha | Linha[] | null }>> = {
    profile: {
      partner: { tabela: 'partnerMembership', achar: (p) => t.partnerMembership.find((m) => m.profileId === p.id) ?? null },
      user: { tabela: 'user', achar: (p) => t.user.find((u) => u.id === p.userId) ?? null },
      firmMembership: { tabela: 'profile', achar: (p) => p.firmMembership ?? null },
    },
    user: {
      profile: { tabela: 'profile', achar: (u) => t.profile.find((p) => p.userId === u.id) ?? null },
    },
    partnerMembership: {
      profile: { tabela: 'profile', achar: (m) => t.profile.find((p) => p.id === m.profileId) ?? null },
      referrals: { tabela: 'partnerReferral', achar: (m) => t.partnerReferral.filter((r) => r.partnerId === m.id) },
      rewards: { tabela: 'partnerReward', achar: (m) => t.partnerReward.filter((r) => r.partnerId === m.id) },
    },
    partnerReferral: {
      partner: { tabela: 'partnerMembership', achar: (r) => t.partnerMembership.find((m) => m.id === r.partnerId) ?? null },
      reward: { tabela: 'partnerReward', achar: (r) => t.partnerReward.find((w) => w.referralId === r.id) ?? null },
      referredUser: { tabela: 'user', achar: (r) => t.user.find((u) => u.id === r.referredUserId) ?? null },
    },
    partnerReward: {
      partner: { tabela: 'partnerMembership', achar: (w) => t.partnerMembership.find((m) => m.id === w.partnerId) ?? null },
      referral: { tabela: 'partnerReferral', achar: (w) => t.partnerReferral.find((r) => r.id === w.referralId) ?? null },
    },
  }

  const igual = (a: unknown, b: unknown) =>
    a instanceof Date || b instanceof Date
      ? (a as Date | null)?.getTime?.() === (b as Date | null)?.getTime?.()
      : a === b

  function compara(v: any, cond: any): boolean {
    if (cond === null) return v === null || v === undefined
    if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime()
    if (typeof cond !== 'object') return v === cond
    if ('in' in cond && !cond.in.some((x: unknown) => igual(v, x))) return false
    if ('not' in cond) {
      if (cond.not === null ? v === null || v === undefined : igual(v, cond.not)) return false
    }
    const n = (x: any) => (x instanceof Date ? x.getTime() : x)
    if ('lte' in cond && !(v != null && n(v) <= n(cond.lte))) return false
    if ('lt' in cond && !(v != null && n(v) < n(cond.lt))) return false
    if ('gte' in cond && !(v != null && n(v) >= n(cond.gte))) return false
    if ('gt' in cond && !(v != null && n(v) > n(cond.gt))) return false
    if ('contains' in cond && !String(v ?? '').includes(cond.contains)) return false
    return true
  }

  function casa(l: Linha, tabela: Tabela, where: any = {}): boolean {
    for (const [k, cond] of Object.entries(where ?? {})) {
      if (k === 'OR') {
        if (!(cond as any[]).some((c) => casa(l, tabela, c))) return false
        continue
      }
      const rel = REL[tabela]?.[k]
      if (rel) {
        const outro = rel.achar(l)
        if (cond === null) {
          if (outro) return false
          continue
        }
        if (!outro || Array.isArray(outro) || !casa(outro, rel.tabela, cond)) return false
        continue
      }
      if (!compara(l[k], cond)) return false
    }
    return true
  }

  function ordenar(linhas: Linha[], orderBy: any): Linha[] {
    const ordens = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Record<string, 'asc' | 'desc'>[]
    const v = (x: any) => (x instanceof Date ? x.getTime() : x)
    return [...linhas].sort((a, b) => {
      for (const o of ordens) {
        const [k, dir] = Object.entries(o)[0]!
        const x = v(a[k])
        const y = v(b[k])
        if (x === y) continue
        const r = x == null ? -1 : y == null ? 1 : x < y ? -1 : 1
        return dir === 'desc' ? -r : r
      }
      return 0
    })
  }

  function projetar(l: Linha, tabela: Tabela, args: any = {}): Linha {
    const sel = args.select
    const inc = args.include
    const base: Linha = sel ? {} : { ...l }
    const campos = sel ?? inc ?? {}
    for (const [k, v] of Object.entries(campos)) {
      if (!v) continue
      if (k === '_count') {
        const contagem: Linha = {}
        for (const [rk, rv] of Object.entries((v as any).select ?? {})) {
          const r = REL[tabela]![rk]!
          const lista = (r.achar(l) as Linha[]).filter((x) => (rv === true ? true : casa(x, r.tabela, (rv as any).where)))
          contagem[rk] = lista.length
        }
        base._count = contagem
        continue
      }
      const rel = REL[tabela]?.[k]
      if (!rel) {
        base[k] = l[k]
        continue
      }
      const outro = rel.achar(l)
      const sub = v === true ? {} : (v as any)
      if (Array.isArray(outro)) {
        let lista = outro.filter((x) => casa(x, rel.tabela, sub.where))
        lista = ordenar(lista, sub.orderBy)
        if (sub.take) lista = lista.slice(0, sub.take)
        base[k] = lista.map((x) => projetar(x, rel.tabela, sub))
      } else {
        base[k] = outro ? projetar(outro, rel.tabela, sub) : null
      }
    }
    return base
  }

  function conferirUnicos(tabela: Tabela, linha: Linha, ignorar?: Linha) {
    for (const campo of UNICOS[tabela] ?? []) {
      const v = linha[campo]
      if (v === null || v === undefined) continue
      if (t[tabela].some((o) => o !== ignorar && igual(o[campo], v))) throw new ErroUnico(`unique ${tabela}.${campo}`)
    }
  }

  function cliente(desfazer?: (() => void)[]) {
    const tabelaOps = (tabela: Tabela) => ({
      findUnique: async (args: any) => {
        await espera()
        const l = t[tabela].find((x) => casa(x, tabela, args.where))
        return l ? projetar(l, tabela, args) : null
      },
      findFirst: async (args: any = {}) => {
        await espera()
        const l = ordenar(t[tabela].filter((x) => casa(x, tabela, args.where)), args.orderBy)[0]
        return l ? projetar(l, tabela, args) : null
      },
      findMany: async (args: any = {}) => {
        await espera()
        let lista = ordenar(t[tabela].filter((x) => casa(x, tabela, args.where)), args.orderBy)
        if (args.cursor) {
          const i = lista.findIndex((x) => x.id === args.cursor.id)
          lista = i < 0 ? [] : lista.slice(i)
        }
        if (args.skip) lista = lista.slice(args.skip)
        if (args.take) lista = lista.slice(0, args.take)
        return lista.map((l) => projetar(l, tabela, args))
      },
      count: async (args: any = {}) => {
        await espera()
        return t[tabela].filter((x) => casa(x, tabela, args.where)).length
      },
      create: async (args: any) => {
        await espera()
        const agora = new Date()
        const linha: Linha = {
          id: novoId(tabela),
          ...(PADROES[tabela]?.() ?? {}),
          createdAt: agora,
          updatedAt: agora,
          ...args.data,
        }
        conferirUnicos(tabela, linha)
        t[tabela].push(linha)
        desfazer?.push(() => {
          t[tabela] = t[tabela].filter((x) => x !== linha)
        })
        return projetar(linha, tabela, args)
      },
      update: async (args: any) => {
        await espera()
        const l = t[tabela].find((x) => casa(x, tabela, args.where))
        if (!l) throw Object.assign(new Error('não encontrado'), { code: 'P2025' })
        const antes = { ...l }
        const depois = { ...l, ...args.data, updatedAt: new Date() }
        conferirUnicos(tabela, depois, l)
        Object.assign(l, depois)
        desfazer?.push(() => {
          for (const k of Object.keys(l)) delete l[k]
          Object.assign(l, antes)
        })
        return projetar(l, tabela, args)
      },
      delete: async (args: any) => {
        await espera()
        const l = t[tabela].find((x) => casa(x, tabela, args.where))
        if (!l) throw Object.assign(new Error('não encontrado'), { code: 'P2025' })
        t[tabela] = t[tabela].filter((x) => x !== l)
        desfazer?.push(() => t[tabela].push(l))
        return l
      },
      deleteMany: async (args: any = {}) => {
        await espera()
        const alvos = t[tabela].filter((x) => casa(x, tabela, args.where))
        t[tabela] = t[tabela].filter((x) => !alvos.includes(x))
        desfazer?.push(() => t[tabela].push(...alvos))
        return { count: alvos.length }
      },
      updateMany: async (args: any) => {
        await espera()
        const alvos = t[tabela].filter((x) => casa(x, tabela, args.where))
        for (const l of alvos) {
          const antes = { ...l }
          Object.assign(l, args.data, { updatedAt: new Date() })
          desfazer?.push(() => {
            for (const k of Object.keys(l)) delete l[k]
            Object.assign(l, antes)
          })
        }
        return { count: alvos.length }
      },
    })
    const c: any = {}
    for (const tabela of Object.keys(t) as Tabela[]) c[tabela] = tabelaOps(tabela)
    return c
  }

  const prisma: any = cliente()
  prisma.$transaction = async (fn: (tx: any) => Promise<unknown>) => {
    const desfazer: (() => void)[] = []
    try {
      return await fn(cliente(desfazer))
    } catch (e) {
      for (const d of desfazer.reverse()) d()
      throw e
    }
  }

  /** Atalho dos testes: conta + perfil, já ligados. */
  function conta(perfil: Linha = {}, email?: string) {
    // E-mail confirmado por padrão: o aceite do programa exige (com o correio ligado).
    const user: Linha = { id: novoId('user'), email: email ?? `pessoa${seq}@exemplo.test`, emailVerifiedAt: new Date(), createdAt: new Date() }
    t.user.push(user)
    const p = {
      id: novoId('profile'),
      userId: user.id,
      name: 'Marina Sales',
      slug: `marina-sales-${seq}`,
      oabNumber: '',
      plan: 'free',
      planStatus: 'active',
      currentPeriodEnd: null,
      graceUntil: null,
      planScheduled: null,
      firmMembership: null,
      ...perfil,
    }
    t.profile.push(p)
    return { user, perfil: p }
  }

  return { prisma, t, conta, novoId: (tabela: Tabela) => novoId(tabela) }
}
