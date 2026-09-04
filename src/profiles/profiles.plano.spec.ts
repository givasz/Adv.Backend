// O QUE ACONTECE COM AS COISAS QUANDO O PLANO CAI.
//
// Esta é a suíte do rebaixamento, e ela existe porque o comportamento real
// contradizia os comentários do próprio código em três lugares: vídeo, marca e
// perguntas frequentes eram APAGADOS do banco no primeiro save depois de um
// rebaixamento, enquanto o código prometia, escrito, que só seriam escondidos.
//
// A regra que estes testes travam é uma só: REBAIXAR ESCONDE, NUNCA APAGA. E a
// coisa mais valiosa do perfil — o endereço público, que está impresso em cartão
// de visita e indexado no Google — não muda porque um cartão de crédito falhou.
//
// Prisma é dublê (o banco de produção é Postgres e não existe aqui): o que se
// verifica é o que o serviço MANDOU gravar.

import { describe, expect, it, vi } from 'vitest'
import { ProfilesService } from './profiles.service'
import { CHAR_LIMITS, FAQ_ANSWER_MAX, FAQ_LIMIT } from '../plans'

type Qualquer = Record<string, any>

// Ancorado no relógio REAL, não numa data fixa: planoVigente decide com
// `new Date()`, e uma âncora congelada apodrece — uma carência de "daqui a 5
// dias" gravada em relação a uma data do passado já nasce vencida, e o teste
// quebra sozinho com o passar do calendário (aconteceu: 2026-09-03).
const HOJE = new Date()
const dias = (n: number) => new Date(HOJE.getTime() + n * 24 * 60 * 60 * 1000)

interface Opcoes {
  /** plano CONTRATADO gravado na linha */
  plan?: 'free' | 'pro' | 'premium'
  planStatus?: string
  currentPeriodEnd?: Date | null
  graceUntil?: Date | null
  planScheduled?: string | null
  slugGraceUntil?: Date | null
  slug?: string
  name?: string
  headline?: string
  bio?: string
  areas?: Qualquer[]
  faqs?: Qualquer[]
  theme?: string
  schedulingMode?: string
  videoUrl?: string | null
  brandName?: string | null
  /** slugs que OUTRA pessoa já ocupa */
  ocupados?: string[]
}

function service(o: Opcoes = {}) {
  const linha = {
    id: 'p1',
    userId: 'u1',
    moderationStatus: 'active',
    plan: o.plan ?? 'premium',
    planStatus: o.planStatus ?? 'active',
    currentPeriodEnd: o.currentPeriodEnd ?? null,
    graceUntil: o.graceUntil ?? null,
    planScheduled: o.planScheduled ?? null,
    slugGraceUntil: o.slugGraceUntil ?? null,
    oabNumber: 'OAB/SP 123',
    name: o.name ?? 'Marina Sales',
    slug: o.slug ?? 'marina-sales',
    headline: o.headline ?? '',
    bio: o.bio ?? '',
    theme: o.theme ?? 'papel',
    schedulingMode: o.schedulingMode ?? 'external',
    videoUrl: o.videoUrl ?? null,
    videoCaption: '',
    card: '',
    brandName: o.brandName ?? null,
    brandAccent: null,
    brandHideWatermark: false,
    customDomain: null,
    areas: o.areas ?? [],
    faqs: o.faqs ?? [],
    socials: [],
    published: true,
    policyRevChecked: 0,
  }

  const gravado: Qualquer[] = []
  const ocupados = new Set(o.ocupados ?? [])
  const prisma: Qualquer = {
    profile: {
      findUnique: vi.fn((a: Qualquer) => {
        // resolveSlug pergunta por SLUG; todo o resto pergunta por userId/id.
        if (a?.where?.slug !== undefined) {
          const s = a.where.slug
          if (ocupados.has(s)) return Promise.resolve({ userId: 'outra-pessoa' })
          if (s === linha.slug) return Promise.resolve({ userId: 'u1' })
          return Promise.resolve(null)
        }
        return Promise.resolve({ ...linha })
      }),
      findFirst: vi.fn(() => Promise.resolve({ ...linha })),
      update: vi.fn((a: Qualquer) => {
        gravado.push(a.data)
        return Promise.resolve({ ...linha, ...a.data, areas: linha.areas, faqs: linha.faqs, socials: [] })
      }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    linkEvent: { create: vi.fn(() => ({ catch: () => undefined })) },
  }
  return { svc: new ProfilesService(prisma as any), gravado, prisma, linha }
}

const base = { name: 'Marina Sales', oabNumber: 'OAB/SP 123', published: false }

// ---------------------------------------------------------------------------

describe('rebaixar esconde, nunca apaga', () => {
  it('salvar no Free NÃO apaga as perguntas frequentes', async () => {
    // Era o pior dos três: com o `deleteMany: {}` de antes, a operação limpava a
    // tabela e não criava nada. Bastava um save qualquer (trocar o telefone
    // servia) para o FAQ sumir para sempre. A janela da cota é o que segura: o que
    // está ALÉM dela não é lido, não é reescrito e não é apagado.
    const { svc, gravado } = service({
      plan: 'free',
      faqs: [
        { id: 'f1', question: 'a?', answer: 'b', order: 0 },
        { id: 'f2', question: 'c?', answer: 'd', order: 1 },
      ],
    })
    await svc.update('u1', { ...base, faqs: [] })
    // Free = 1 pergunta desde 04/09/2026: a janela apaga só a posição 0.
    expect(gravado[0].faqs).toEqual({ deleteMany: { order: { lt: 1 } }, create: [] })
  })

  it('salvar fora do Max NÃO zera o vídeo', async () => {
    // `videoUrl: canUseVideo(plan) ? ... : null` gravava null explícito.
    const { svc, gravado } = service({ plan: 'pro', videoUrl: 'https://youtu.be/abc' })
    await svc.update('u1', { ...base })
    expect(gravado[0]).not.toHaveProperty('videoUrl')
    expect(gravado[0]).not.toHaveProperty('videoCaption')
  })

  it('salvar fora do Max NÃO zera a marca própria', async () => {
    // O mais traiçoeiro: fora do Max a resposta da API omite `branding`, então o
    // editor devolvia o perfil sem ele e as quatro colunas eram gravadas como null.
    const { svc, gravado } = service({ plan: 'free', brandName: 'Sales Advocacia' })
    await svc.update('u1', { ...base })
    expect(gravado[0]).not.toHaveProperty('brandName')
    expect(gravado[0]).not.toHaveProperty('brandAccent')
    expect(gravado[0]).not.toHaveProperty('brandHideWatermark')
    expect(gravado[0]).not.toHaveProperty('customDomain')
  })

  it('no Max, marca e vídeo continuam sendo gravados normalmente', async () => {
    const { svc, gravado } = service({ plan: 'premium' })
    await svc.update('u1', {
      ...base,
      videoUrl: 'https://www.youtube.com/watch?v=abc12345678',
      branding: { brandName: 'Sales Advocacia', accent: '#8a5a2b' },
    })
    expect(gravado[0].videoUrl).toContain('youtube')
    expect(gravado[0].brandName).toBe('Sales Advocacia')
    expect(gravado[0].brandAccent).toBe('#8a5a2b')
  })

  it('o save só substitui as áreas DENTRO da cota — o excedente fica intacto', async () => {
    // Max com 5 áreas que cai para o Free (cota 1): as outras 4 não são apagadas,
    // ficam congeladas esperando o plano voltar.
    const { svc, gravado } = service({
      plan: 'free',
      areas: Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, label: `A${i}`, description: '', order: i })),
    })
    await svc.update('u1', { ...base, areas: [{ label: 'A0', description: '' }, { label: 'A1', description: '' }] })
    expect(gravado[0].areas.deleteMany).toEqual({ order: { lt: 1 } })
    expect(gravado[0].areas.create).toHaveLength(1)
  })
})

describe('o endereço público sobrevive ao rebaixamento', () => {
  it('salvar no Free NÃO renumera um endereço limpo', async () => {
    // advoc.me/marina-sales vira advoc.me/marina-sales-4827 e todo cartão de visita
    // impresso, QR e link indexado passa a apontar para um 404.
    const { svc, gravado } = service({ plan: 'free', slug: 'marina-sales' })
    await svc.update('u1', { ...base })
    expect(gravado[0].slug).toBe('marina-sales')
  })

  it('corrigir o nome no Free não muda o endereço', async () => {
    const { svc, gravado } = service({ plan: 'free', slug: 'marina-salles-4827', name: 'Marina Salles' })
    await svc.update('u1', { ...base, name: 'Marina Sales' })
    expect(gravado[0].slug).toBe('marina-salles-4827')
  })

  it('o Free continua sem poder ESCOLHER o endereço', async () => {
    // Preservar o que já existe é uma coisa; deixar escolher é o perk que o Pro
    // cobra. O slug do corpo da requisição é ignorado.
    const { svc, gravado } = service({ plan: 'free', slug: 'marina-sales-4827' })
    await svc.update('u1', { ...base, slug: 'melhor-advogada-de-sp' })
    expect(gravado[0].slug).toBe('marina-sales-4827')
  })

  it('endereço tomado por outra pessoa: sorteia um novo em vez de estourar', async () => {
    const { svc, gravado } = service({ plan: 'free', slug: 'marina-sales', ocupados: ['marina-sales'] })
    await svc.update('u1', { ...base })
    expect(gravado[0].slug).toMatch(/^marina-sales-\d{4}$/)
  })

  it('no Pro o endereço continua editável', async () => {
    const { svc, gravado } = service({ plan: 'pro', slug: 'marina-sales' })
    await svc.update('u1', { ...base, slug: 'marina-sales-advocacia' })
    expect(gravado[0].slug).toBe('marina-sales-advocacia')
  })
})

describe('o teto de caracteres não sequestra o editor de quem rebaixou', () => {
  it('bio herdada de um plano maior não trava o save', async () => {
    // Mil caracteres escritos no Max, plano caiu para o Free (300). Antes, QUALQUER
    // save respondia 400 — inclusive um que só trocava o telefone.
    const bio = 'x'.repeat(1000)
    const { svc, gravado } = service({ plan: 'free', bio })
    await expect(svc.update('u1', { ...base, bio })).resolves.toBeTruthy()
    expect(gravado[0].bio).toBe(bio)
  })

  it('mas o texto não pode CRESCER acima do teto do plano', async () => {
    const { svc } = service({ plan: 'free', bio: 'x'.repeat(1000) })
    await expect(svc.update('u1', { ...base, bio: 'x'.repeat(1001) })).rejects.toThrow(
      new RegExp(`limite de ${CHAR_LIMITS.free.bio}`, 'i'),
    )
  })

  it('encurtar sempre pode, mesmo continuando acima do teto', async () => {
    const { svc, gravado } = service({ plan: 'free', bio: 'x'.repeat(1000) })
    await svc.update('u1', { ...base, bio: 'x'.repeat(700) })
    expect(gravado[0].bio).toHaveLength(700)
  })

  it('área NOVA responde pelo teto do plano', async () => {
    // O herdado é casado pelo rótulo; um rótulo que não existia é texto crescendo.
    const { svc } = service({
      plan: 'free',
      areas: [{ id: 'a0', label: 'Família', description: 'y'.repeat(400), order: 0 }],
    })
    await expect(
      svc.update('u1', { ...base, areas: [{ label: 'Trabalhista', description: 'y'.repeat(400) }] }),
    ).rejects.toThrow(new RegExp(`limite de ${CHAR_LIMITS.free.areaDesc}`, 'i'))
  })

  it('a MESMA área herdada, com o mesmo texto, passa', async () => {
    const { svc, gravado } = service({
      plan: 'free',
      areas: [{ id: 'a0', label: 'Família', description: 'y'.repeat(400), order: 0 }],
    })
    await svc.update('u1', { ...base, areas: [{ label: 'Família', description: 'y'.repeat(400) }] })
    expect(gravado[0].areas.create[0].description).toHaveLength(400)
  })
})

describe('a leitura entrega o plano VIGENTE, não o contratado', () => {
  it('assinatura vencida entrega Free mesmo com premium gravado', async () => {
    // A varredura reconcilia o banco depois; a leitura não espera por ela, senão
    // haveria uma janela em que o perfil público entrega o que ninguém pagou.
    const { svc } = service({
      plan: 'premium',
      planStatus: 'past_due',
      graceUntil: dias(-1),
      theme: 'obsidian',
      schedulingMode: 'assistant',
      videoUrl: 'https://youtu.be/abc',
      faqs: [{ id: 'f1', question: 'a?', answer: 'b', order: 0 }],
    })
    const p: Qualquer = await svc.getMine('u1')
    expect(p.plan).toBe('free')
    expect(p.theme).toBe('papel')
    expect(p.schedulingMode).toBe('off')
    expect(p.videoUrl).toBeUndefined()
    // O Free responde UMA pergunta desde 04/09/2026 — o que cai para o Free perde
    // as EXCEDENTES, não o recurso inteiro.
    expect(p.faqs).toHaveLength(FAQ_LIMIT.free)
  })

  it('cartão recusado ontem NÃO tira nada do ar', async () => {
    const { svc } = service({
      plan: 'premium',
      planStatus: 'past_due',
      graceUntil: dias(5),
      theme: 'obsidian',
    })
    const p: Qualquer = await svc.getMine('u1')
    expect(p.plan).toBe('premium')
    expect(p.theme).toBe('obsidian')
    expect(p.subscription).toMatchObject({ plan: 'premium', status: 'past_due', cortesia: true })
  })

  it('o dono vê a situação da assinatura; o visitante não', async () => {
    const { svc } = service({ plan: 'pro', planStatus: 'past_due', graceUntil: dias(3) })
    const meu: Qualquer = await svc.getMine('u1')
    expect(meu.subscription).toBeTruthy()
    const publico: Qualquer = await svc.getBySlug('marina-sales')
    expect(publico.subscription).toBeUndefined()
  })

  it('a cota corta por POSIÇÃO, para nada congelado subir para a vaga vazia', async () => {
    // Se o corte fosse "as N primeiras", apagar uma pergunta visível faria uma
    // pergunta antiga (congelada) aparecer do nada na tela.
    const { svc } = service({
      plan: 'pro',
      faqs: [
        { id: 'f0', question: 'q0', answer: 'a', order: 0 },
        { id: 'f2', question: 'q2', answer: 'a', order: 2 },
        { id: 'f3', question: 'q3', answer: 'a', order: 3 },
      ],
    })
    const p: Qualquer = await svc.getMine('u1')
    expect(p.faqs.map((f: Qualquer) => f.id)).toEqual(['f0'])
  })
})

describe('troca de plano', () => {
  it('rebaixar NÃO mexe no endereço', async () => {
    const { svc, gravado } = service({ plan: 'premium', slug: 'marina-sales' })
    await svc.setPlan('u1', 'free')
    expect(gravado[0]).not.toHaveProperty('slug')
  })

  it('rebaixar desliga agendamento e tema pagos na hora', async () => {
    const { svc, gravado } = service({ plan: 'premium', theme: 'obsidian', schedulingMode: 'assistant' })
    await svc.setPlan('u1', 'free')
    expect(gravado[0].theme).toBe('papel')
    expect(gravado[0].schedulingMode).toBe('off')
  })

  it('subir tira o número automático do endereço', async () => {
    const { svc, gravado } = service({ plan: 'free', slug: 'marina-sales-4827' })
    await svc.setPlan('u1', 'pro')
    expect(gravado[0].slug).toBe('marina-sales')
  })

  it('descer com mês pago é AGENDADO — nada muda hoje', async () => {
    const { svc, gravado } = service({
      plan: 'premium',
      currentPeriodEnd: dias(15),
      theme: 'obsidian',
    })
    await svc.setPlan('u1', 'pro')
    expect(gravado[0].planScheduled).toBe('pro')
    expect(gravado[0].plan).toBeUndefined()
    // O tema do Max continua de pé: ela pagou o mês.
    expect(gravado[0].theme).toBe('obsidian')
  })

  it('plano inválido é recusado', async () => {
    const { svc } = service()
    await expect(svc.setPlan('u1', 'deus')).rejects.toThrow(/inválido/i)
    await expect(svc.setPlan('u1', { plan: 'premium' })).rejects.toThrow(/inválido/i)
  })
})

// ---------------------------------------------------------------------------

describe('o endereço vira prazo quando o plano cai — não some junto com ele', () => {
  // O endereço sem número é o perk mais visível do Pro. Se ele ficasse para
  // sempre, o rebaixamento não teria peso nenhum; se saísse no mesmo instante,
  // seria emboscada — o link está impresso em cartão e indexado no Google.
  // A resposta é a do meio: sete dias, com a data no painel desde o primeiro.

  it('cair para o Free abre o prazo do endereço, e NÃO troca o endereço agora', async () => {
    const { svc, gravado } = service({ plan: 'premium', slug: 'marina-sales' })
    await svc.setPlan('u1', 'free')
    expect(gravado[0].slug).toBeUndefined() // o endereço de hoje continua o dela
    const prazo = gravado[0].slugGraceUntil as Date
    expect(prazo).toBeInstanceOf(Date)
    const faltam = (prazo.getTime() - Date.now()) / (24 * 60 * 60 * 1000)
    expect(faltam).toBeGreaterThan(6.5)
    expect(faltam).toBeLessThan(7.5)
  })

  it('quem já estava numerado não tem endereço limpo a perder', async () => {
    const { svc, gravado } = service({ plan: 'premium', slug: 'marina-sales-4827' })
    await svc.setPlan('u1', 'free')
    expect(gravado[0].slugGraceUntil).toBeUndefined()
  })

  it('descer de Max para Pro não mexe no endereço: o Pro também tem nome limpo', async () => {
    const { svc, gravado } = service({ plan: 'premium', slug: 'marina-sales' })
    await svc.setPlan('u1', 'pro')
    expect(gravado[0].slugGraceUntil).toBeNull()
    expect(gravado[0].slug).toBeUndefined()
  })

  it('reassinar dentro da semana APAGA o prazo — ninguém perde o endereço pagando', async () => {
    const { svc, gravado } = service({
      plan: 'free',
      planStatus: 'canceled',
      slug: 'marina-sales',
      slugGraceUntil: dias(3),
    })
    await svc.setPlan('u1', 'pro')
    expect(gravado[0].slugGraceUntil).toBeNull()
  })
})

describe('o carimbo do endereço (varredura diária)', () => {
  it('prazo vencido no Free: o número volta e a troca vai para a trilha', async () => {
    const { svc, gravado, prisma } = service({
      plan: 'free',
      planStatus: 'canceled',
      slug: 'marina-sales',
      slugGraceUntil: dias(-1),
    })
    const r = await svc.carimbarEnderecoVencido('p1')
    expect(r).toEqual({ anterior: 'marina-sales', novo: expect.stringMatching(/^marina-sales-\d{4}$/) })
    expect(gravado[0].slug).toMatch(/^marina-sales-\d{4}$/)
    expect(gravado[0].slugGraceUntil).toBeNull()
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ bioSnapshot: expect.stringContaining('marina-sales') }),
      }),
    )
  })

  it('dentro do prazo não faz nada', async () => {
    const { svc, gravado } = service({
      plan: 'free',
      planStatus: 'canceled',
      slug: 'marina-sales',
      slugGraceUntil: dias(2),
    })
    expect(await svc.carimbarEnderecoVencido('p1')).toBeNull()
    expect(gravado).toHaveLength(0)
  })

  it('voltou a pagar com o prazo vencido: o endereço fica, o prazo é apagado', async () => {
    // A segunda tranca. Entre a consulta da varredura e a escrita cabe um
    // pagamento; renumerar quem está pagando seria o pior erro desta rotina.
    const { svc, gravado } = service({
      plan: 'pro',
      planStatus: 'active',
      currentPeriodEnd: dias(20),
      slug: 'marina-sales',
      slugGraceUntil: dias(-1),
    })
    expect(await svc.carimbarEnderecoVencido('p1')).toBeNull()
    expect(gravado[0]).toEqual({ slugGraceUntil: null })
  })

  it('sem prazo marcado, não há o que carimbar', async () => {
    const { svc, gravado } = service({ plan: 'free', slug: 'marina-sales' })
    expect(await svc.carimbarEnderecoVencido('p1')).toBeNull()
    expect(gravado).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------

describe('um assunto por campo — a cota não pode ser burlada por dentro', () => {
  // O Free entrega UMA área e UMA pergunta. Um limite de CONTAGEM sozinho não
  // segura nada: quem quer três áreas escreve as três no rótulo único. Conferir
  // isso só no editor seria pedir por favor — o servidor é quem grava.

  it('rótulo com enumeração é recusado, e o erro traz a sugestão de corte', async () => {
    const { svc } = service({ plan: 'free' })
    await expect(
      svc.update('u1', { ...base, areas: [{ label: 'Família, Sucessões', description: '' }] }),
    ).rejects.toThrow(/mais de uma área/i)
    await expect(
      svc.update('u1', { ...base, areas: [{ label: 'Cível / Criminal', description: '' }] }),
    ).rejects.toThrow(/Direito|Cível/)
  })

  it('nome legítimo de área passa — este é o lado que não pode falhar', async () => {
    // Uma trava que reprova "Direito de Família e Sucessões" faz o advogado brigar
    // com o editor, e ele tem razão: é o nome consagrado de UMA área.
    const { svc, gravado } = service({ plan: 'free' })
    await svc.update('u1', {
      ...base,
      areas: [{ label: 'Direito de Família e Sucessões', description: '' }],
    })
    expect(gravado[0].areas.create[0].label).toBe('Direito de Família e Sucessões')
  })

  it('rótulo JÁ GRAVADO assim continua salvando — a trava vale para o que entra', async () => {
    // Quem escreveu "Cível / Criminal" antes desta trava existir não pode
    // descobrir isso ao tentar trocar o telefone, com o save inteiro recusado por
    // um campo que ele não tocou. Mesma regra do teto de caracteres.
    const { svc, gravado } = service({
      plan: 'free',
      areas: [{ id: 'a0', label: 'Cível / Criminal', description: '', order: 0 }],
    })
    await svc.update('u1', { ...base, areas: [{ label: 'Cível / Criminal', description: '' }] })
    expect(gravado[0].areas.create[0].label).toBe('Cível / Criminal')
  })

  it('duas interrogações numa pergunta são recusadas', async () => {
    const { svc } = service({ plan: 'free' })
    await expect(
      svc.update('u1', {
        ...base,
        faqs: [{ question: 'Quanto custa? Quanto demora?', answer: 'Depende do caso.' }],
      }),
    ).rejects.toThrow(/mais de uma pergunta/i)
  })

  it('uma pergunta só passa, com vírgula e tudo', async () => {
    const { svc, gravado } = service({ plan: 'free' })
    await svc.update('u1', {
      ...base,
      faqs: [{ question: 'Quanto tempo demora, em média?', answer: 'Depende do caso.' }],
    })
    expect(gravado[0].faqs.create).toHaveLength(1)
  })
})

describe('os tetos de texto por plano não apagam o que foi escrito num plano maior', () => {
  it('pergunta NOVA no Free responde pelo teto curto do Free', async () => {
    const { svc, gravado } = service({ plan: 'free' })
    const longa = 'y'.repeat(400)
    await svc.update('u1', { ...base, faqs: [{ question: 'Como funciona?', answer: longa }] })
    expect(gravado[0].faqs.create[0].answer).toHaveLength(FAQ_ANSWER_MAX.free)
  })

  it('resposta HERDADA do Max não é cortada ao salvar no Free', async () => {
    // Sem esta regra, o primeiro save depois de um rebaixamento comeria 60
    // caracteres da resposta — em silêncio, e sem ninguém ter pedido.
    const herdada = 'y'.repeat(FAQ_ANSWER_MAX.premium)
    const { svc, gravado } = service({
      plan: 'free',
      faqs: [{ id: 'f0', question: 'Como funciona?', answer: herdada, order: 0 }],
    })
    await svc.update('u1', { ...base, faqs: [{ question: 'Como funciona?', answer: herdada }] })
    expect(gravado[0].faqs.create[0].answer).toHaveLength(FAQ_ANSWER_MAX.premium)
  })
})
