// A fila de e-mail. O que ela promete, e este arquivo cobra:
//
//   • aviso repetido (mesma chave) entra uma vez;
//   • depois de sair, a linha perde o endereço e os dados — fica a impressão digital;
//   • quem espera na tela (senha) sai antes do aviso em massa (Termos);
//   • falha passageira tenta de novo; permanente desiste; chave recusada põe a
//     fila em espera SEM descartar ninguém;
//   • link vencido não sai;
//   • o aviso em massa nunca gasta a reserva do dia.

import { describe, expect, it, vi } from 'vitest'
import { CorreioService, esperaDaTentativa, RESERVA_DO_DIA } from './correio.service'
import type { EnvioResend, ResultadoEnvio } from './resend'
import { fingerprint } from '../security/audit-log'

const TOKEN = 'B'.repeat(43)

interface Linha {
  id: string
  modelo: string
  para: string
  destinatario: string
  userId: string | null
  dados: string
  chave: string | null
  prioridade: number
  status: string
  tentativas: number
  proximaTentativa: Date
  validoAte: Date | null
  erro: string
  provedorId: string
  createdAt: Date
  enviadoEm: Date | null
}

/** Um pedaço de Prisma em memória — só o que o serviço usa. */
function banco() {
  const linhas: Linha[] = []
  let n = 0
  const casa = (l: Linha, where: Record<string, any>) =>
    Object.entries(where).every(([campo, v]) => {
      const atual = (l as any)[campo]
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('lte' in v) return atual !== null && atual <= v.lte
        if ('gte' in v) return atual !== null && atual >= v.gte
      }
      return atual === v
    })
  const mailOutbox = {
    create: async ({ data }: any) => {
      if (data.chave && linhas.some((l) => l.chave === data.chave)) {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
      }
      n++
      const l: Linha = {
        id: `m${n}`,
        status: 'pendente',
        tentativas: 0,
        proximaTentativa: new Date(Date.now() - 1),
        erro: '',
        provedorId: '',
        createdAt: new Date(Date.now() + n),
        enviadoEm: null,
        validoAte: null,
        userId: null,
        chave: null,
        ...data,
      }
      linhas.push(l)
      return l
    },
    findMany: async ({ where, take }: any) =>
      linhas
        .filter((l) => casa(l, where))
        .sort((a, b) => a.prioridade - b.prioridade || a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, take)
        .map((l) => ({ ...l })),
    count: async ({ where }: any) => linhas.filter((l) => casa(l, where)).length,
    updateMany: async ({ where, data }: any) => {
      const alvo = linhas.filter((l) => casa(l, where))
      for (const l of alvo) Object.assign(l, data)
      return { count: alvo.length }
    },
    update: async ({ where, data }: any) => Object.assign(linhas.find((l) => l.id === where.id)!, data),
  }
  return { linhas, prisma: { mailOutbox } }
}

function servico(
  opts: {
    modo?: 'resend' | 'console'
    teto?: number
    resposta?: (e: EnvioResend) => ResultadoEnvio
  } = {},
) {
  const { linhas, prisma } = banco()
  const svc = new CorreioService(prisma as never)
  svc.config = {
    modo: opts.modo ?? 'resend',
    ativo: true,
    apiKey: 're_teste',
    remetente: 'advoc.me <avisos@advoc.me>',
    siteUrl: 'https://site.test',
    tetoDiario: opts.teto ?? 100,
    aviso: '',
  }
  const enviados: EnvioResend[] = []
  svc.transporte = vi.fn(async (e: EnvioResend) => {
    enviados.push(e)
    return opts.resposta?.(e) ?? { ok: true as const, id: `em_${enviados.length}` }
  })
  svc.esperar = async () => undefined
  // O despacho imediato vira chamada explícita nos testes.
  ;(svc as any).cutucar = () => undefined
  return { svc, linhas, enviados }
}

const REDEFINIR = { modelo: 'redefinir-senha' as const, para: 'Marina@Exemplo.com', dados: { token: TOKEN } }

describe('entrar na fila', () => {
  it('endereço inválido não entra', async () => {
    const { svc, linhas } = servico()
    expect(await svc.enfileirar({ ...REDEFINIR, para: 'não é e-mail' })).toBe(false)
    expect(linhas).toHaveLength(0)
  })

  it('a mesma chave entra uma vez', async () => {
    const { svc, linhas } = servico()
    const aviso = { modelo: 'termos-atualizados' as const, para: 'a@b.com', chave: 'termos:v:u1', dados: { versao: '2026-09-12' } }
    expect(await svc.enfileirar(aviso)).toBe(true)
    expect(await svc.enfileirar(aviso)).toBe(false)
    expect(linhas).toHaveLength(1)
  })
})

describe('sair da fila', () => {
  it('depois de sair, fica a impressão digital — o endereço e os dados somem', async () => {
    const { svc, linhas, enviados } = servico()
    await svc.enfileirar(REDEFINIR)
    expect((await svc.despachar()).enviados).toBe(1)

    expect(enviados[0]!.para).toBe('marina@exemplo.com')
    expect(enviados[0]!.chaveDeIdempotencia).toBe(linhas[0]!.id)
    expect(enviados[0]!.texto).toContain(`https://site.test/redefinir-senha#t=${TOKEN}`)
    expect(linhas[0]).toMatchObject({
      status: 'enviado',
      para: '',
      dados: '{}',
      destinatario: fingerprint('marina@exemplo.com'),
      provedorId: 'em_1',
    })
    expect(linhas[0]!.enviadoEm).toBeInstanceOf(Date)
  })

  it('quem espera na tela passa na frente do aviso em massa', async () => {
    const { svc, enviados } = servico()
    await svc.enfileirar({ modelo: 'termos-atualizados', para: 'a@b.com', dados: { versao: '2026-09-12' } })
    await svc.enfileirar({ modelo: 'moderacao-decisao', para: 'b@b.com', dados: { acao: 'warn', motivo: 'x' } })
    await svc.enfileirar(REDEFINIR)
    await svc.despachar()
    expect(enviados.map((e) => e.etiqueta)).toEqual(['redefinir-senha', 'moderacao-decisao', 'termos-atualizados'])
  })

  it('falha passageira: tenta de novo mais tarde, sem perder o endereço', async () => {
    const { svc, linhas } = servico({
      resposta: () => ({ ok: false, tipo: 'transitorio', status: 500, erro: '500 internal' }),
    })
    await svc.enfileirar(REDEFINIR)
    await svc.despachar()
    expect(linhas[0]).toMatchObject({ status: 'pendente', tentativas: 1, para: 'marina@exemplo.com' })
    expect(linhas[0]!.proximaTentativa.getTime()).toBeGreaterThan(Date.now() + 30_000)
  })

  it('falha permanente: para de tentar, e o endereço some', async () => {
    const { svc, linhas } = servico({
      resposta: () => ({ ok: false, tipo: 'permanente', status: 422, erro: '422 validation_error' }),
    })
    await svc.enfileirar(REDEFINIR)
    await svc.despachar()
    expect(linhas[0]).toMatchObject({ status: 'falhou', para: '', dados: '{}' })
  })

  it('desiste depois da oitava tentativa', async () => {
    const { svc, linhas } = servico({
      resposta: () => ({ ok: false, tipo: 'transitorio', status: 503, erro: '503' }),
    })
    await svc.enfileirar(REDEFINIR)
    linhas[0]!.tentativas = 7
    await svc.despachar()
    expect(linhas[0]).toMatchObject({ status: 'falhou', tentativas: 8, para: '' })
  })

  it('chave recusada: ninguém é descartado, e a fila inteira espera', async () => {
    const { svc, linhas, enviados } = servico({
      resposta: () => ({ ok: false, tipo: 'credencial', status: 403, erro: '403 invalid_api_key', esperarMs: 600_000 }),
    })
    await svc.enfileirar(REDEFINIR)
    await svc.enfileirar({ ...REDEFINIR, para: 'outra@exemplo.com' })
    await svc.despachar()
    expect(enviados).toHaveLength(1)
    expect(linhas.every((l) => l.status === 'pendente' && l.tentativas === 0 && l.para)).toBe(true)

    // Nem um aviso novo sai enquanto a espera vale.
    await svc.enfileirar({ ...REDEFINIR, para: 'terceira@exemplo.com' })
    await svc.despachar()
    expect(enviados).toHaveLength(1)
  })

  it('link vencido não sai', async () => {
    const { svc, linhas, enviados } = servico()
    await svc.enfileirar({ ...REDEFINIR, validoAte: new Date(Date.now() - 1000) })
    await svc.despachar()
    expect(enviados).toHaveLength(0)
    expect(linhas[0]).toMatchObject({ status: 'expirado', para: '', dados: '{}' })
  })

  it('o aviso em massa não gasta a reserva do dia; a senha passa', async () => {
    const teto = RESERVA_DO_DIA + 5
    const { svc, linhas, enviados } = servico({ teto })
    // Já saíram 5 hoje: o aviso em massa só podia usar até o teto menos a reserva.
    for (let i = 0; i < 5; i++) {
      await svc.enfileirar({ modelo: 'conta-reativada', para: `x${i}@b.com` })
      Object.assign(linhas[i]!, { status: 'enviado', enviadoEm: new Date() })
    }
    await svc.enfileirar({ modelo: 'termos-atualizados', para: 'a@b.com', dados: { versao: '2026-09-12' } })
    await svc.enfileirar(REDEFINIR)
    const r = await svc.despachar()
    expect(enviados.map((e) => e.etiqueta)).toEqual(['redefinir-senha'])
    expect(r.adiados).toBe(1)
    expect(linhas.find((l) => l.modelo === 'termos-atualizados')!.status).toBe('pendente')
  })

  it('no console do desenvolvimento nada sai para fora, e o aviso conta como entregue', async () => {
    const { svc, linhas, enviados } = servico({ modo: 'console' })
    vi.spyOn((svc as any).log, 'log').mockImplementation(() => undefined)
    await svc.enfileirar(REDEFINIR)
    await svc.despachar()
    expect(enviados).toHaveLength(0)
    expect(linhas[0]!.status).toBe('enviado')
  })

  it('modelo que não monta vira falha, e a fila segue', async () => {
    const { svc, linhas, enviados } = servico()
    vi.spyOn((svc as any).log, 'warn').mockImplementation(() => undefined)
    await svc.enfileirar({ modelo: 'redefinir-senha', para: 'a@b.com', dados: {} })
    await svc.enfileirar(REDEFINIR)
    await svc.despachar()
    expect(linhas[0]!.status).toBe('falhou')
    expect(enviados).toHaveLength(1)
  })
})

describe('espera entre tentativas', () => {
  it('dobra a cada tentativa, até seis horas', () => {
    expect(esperaDaTentativa(1)).toBe(60_000)
    expect(esperaDaTentativa(2)).toBe(120_000)
    expect(esperaDaTentativa(30)).toBe(6 * 60 * 60 * 1000)
  })
})
