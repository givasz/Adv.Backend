import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AnalyticsService } from './analytics.service'
import { EVENTOS, EVENTOS_DE_CONTATO, ehEvento } from './eventos'

// O bug que este arquivo existe para não deixar voltar: a tela "Quem visita você"
// mostrava 0 para todo mundo, sempre. Lia `Profile.views`, uma coluna que nada
// incrementava, enquanto a visita real ia para LinkEvent e nunca era lida.

function servico(linhas: { kind: string; createdAt: Date }[], perfilId: string | null = 'p1') {
  const prisma = {
    profile: {
      findUnique: vi.fn(async () => (perfilId ? { id: perfilId, plan: 'pro' } : null)),
      findFirst: vi.fn(async () => (perfilId ? { id: perfilId } : null)),
    },
    linkEvent: {
      count: vi.fn(async () => linhas.filter((l) => l.kind === 'view').length),
      findMany: vi.fn(async () => linhas),
      create: vi.fn(async () => ({})),
    },
  }
  return { s: new AnalyticsService(prisma as never), prisma }
}

const hoje = (hora = 10) => {
  const d = new Date()
  d.setHours(hora, 0, 0, 0)
  return d
}

describe('a lista de eventos é fechada', () => {
  // `kind` é texto livre no banco e a rota é pública e sem sessão. Sem esta
  // conferência, um laço de terminal encheria a tabela de outra pessoa com
  // qualquer string.
  it('recusa o que não está na lista', () => {
    expect(ehEvento('view')).toBe(true)
    expect(ehEvento('whatsapp')).toBe(true)
    expect(ehEvento('rede:instagram')).toBe(true)
    expect(ehEvento('qualquer-coisa')).toBe(false)
    expect(ehEvento('')).toBe(false)
    expect(ehEvento(42)).toBe(false)
    expect(ehEvento(null)).toBe(false)
  })

  it('todo evento de contato é um evento válido', () => {
    for (const e of EVENTOS_DE_CONTATO) expect(EVENTOS).toContain(e)
  })

  it('não grava evento fora da lista', async () => {
    const { s, prisma } = servico([])
    await s.registrar('ana', 'inventado')
    expect(prisma.linkEvent.create).not.toHaveBeenCalled()
  })

  it('não grava para perfil que não existe ou não está publicado', async () => {
    const { s, prisma } = servico([], null)
    await s.registrar('fantasma', 'view')
    expect(prisma.linkEvent.create).not.toHaveBeenCalled()
  })
})

describe('o resumo conta o que aconteceu de verdade', () => {
  let dados: { kind: string; createdAt: Date }[]

  beforeEach(() => {
    dados = [
      { kind: 'view', createdAt: hoje(9) },
      { kind: 'view', createdAt: hoje(9) },
      { kind: 'view', createdAt: hoje(14) },
      { kind: 'view', createdAt: hoje(14) },
      { kind: 'whatsapp', createdAt: hoje(14) },
      { kind: 'rede:instagram', createdAt: hoje(15) },
    ]
  })

  it('o total de visitas NÃO é zero quando houve visita', async () => {
    const { s } = servico(dados)
    const r = await s.resumoDoDono('u1', 'pro')
    expect(r.visitas.total).toBe(4)
    expect(r.visitas.janela).toBe(4)
  })

  it('separa cliques de visitas e ordena do mais usado', async () => {
    const { s } = servico([...dados, { kind: 'whatsapp', createdAt: hoje(16) }])
    const r = await s.resumoDoDono('u1', 'pro')
    expect(r.cliques[0]).toEqual({ evento: 'whatsapp', total: 2 })
    expect(r.cliques.map((c) => c.evento)).not.toContain('view')
  })

  it('conta como contato só o que é tentativa de falar com o advogado', async () => {
    const { s } = servico(dados)
    const r = await s.resumoDoDono('u1', 'pro')
    // whatsapp conta; rede social não é contato, é curiosidade.
    expect(r.contatos).toBe(1)
    expect(r.taxaDeContato).toBe(25)
  })

  it('taxa de contato é null (não zero) quando ninguém visitou', async () => {
    const { s } = servico([])
    const r = await s.resumoDoDono('u1', 'pro')
    // Zero se leria como "ninguém entrou em contato"; o certo é "não dá para dizer".
    expect(r.taxaDeContato).toBeNull()
  })

  it('distribui as visitas pelas horas do dia', async () => {
    const { s } = servico(dados)
    const r = await s.resumoDoDono('u1', 'pro')
    expect(r.porHora).toHaveLength(24)
    expect(r.porHora[9]).toBe(2)
    expect(r.porHora[14]).toBe(2)
    expect(r.porHora.reduce((a, b) => a + b, 0)).toBe(4)
  })

  // Um gráfico que pula os dias sem movimento mente sobre o ritmo: três visitas
  // em três semanas viram uma linha reta que parece movimento diário.
  it('inclui os dias vazios da janela', async () => {
    const { s } = servico(dados)
    const r = await s.resumoDoDono('u1', 'pro')
    expect(r.porDia).toHaveLength(r.janelaDias)
    expect(r.porDia.filter((d) => d.visitas === 0).length).toBe(r.janelaDias - 1)
    expect(r.porDia[r.porDia.length - 1]).toMatchObject({ visitas: 4, contatos: 1 })
  })
})

describe('o detalhe é recurso pago', () => {
  const dados = [
    { kind: 'view', createdAt: hoje() },
    { kind: 'whatsapp', createdAt: hoje() },
  ]

  it('no Free vem só o volume de visitas', async () => {
    const { s } = servico(dados)
    const r = await s.resumoDoDono('u1', 'free')
    expect(r.detalhado).toBe(false)
    expect(r.visitas.total).toBe(1)
    expect(r.cliques).toEqual([])
    expect(r.porHora).toEqual([])
    expect(r.porDia).toEqual([])
  })

  it('no Pro e no Max vem tudo', async () => {
    for (const plano of ['pro', 'premium'] as const) {
      const { s } = servico(dados)
      const r = await s.resumoDoDono('u1', plano)
      expect(r.detalhado).toBe(true)
      expect(r.cliques).toHaveLength(1)
      expect(r.porHora).toHaveLength(24)
    }
  })
})
