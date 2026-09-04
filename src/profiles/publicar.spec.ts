// O QUE O ATO DE PUBLICAR EXIGE — aceite dos Termos e declaração de veracidade.
//
// Estas duas recusas são a espinha da defesa da plataforma: sem elas, "a
// responsabilidade é de quem publicou" é uma frase num documento; com elas, é um
// registro datado com endereço. Por isso têm teste próprio, e não uma linha
// perdida no meio do saneamento de entrada.
//
// Prisma é dublê — o que se verifica é o que o serviço RECUSOU e o que mandou
// gravar.

import { describe, expect, it, vi } from 'vitest'
import { ProfilesService } from './profiles.service'
import { TERMS_VERSION } from '../legal/termos'

type Qualquer = Record<string, any>

function service(atual: Qualquer = {}) {
  const gravado: Qualquer[] = []
  const acessos: Qualquer[] = []
  const prisma: Qualquer = {
    profile: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'p1',
        moderationStatus: 'active',
        plan: 'premium',
        oabNumber: '123',
        userId: 'u1',
        published: false,
        user: { termsVersion: TERMS_VERSION },
        ...atual,
      }),
      update: vi.fn((a: Qualquer) => {
        gravado.push(a.data)
        return Promise.resolve({ ...a.data, plan: 'premium', areas: [], faqs: [], socials: [] })
      }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    accessLog: { create: vi.fn((a: Qualquer) => (acessos.push(a.data), Promise.resolve({}))) },
  }
  return { svc: new ProfilesService(prisma as any), gravado, acessos }
}

const completo = { name: 'Marina Sales', oabNumber: 'OAB/SP 123', published: true }
const origem = { ip: '198.51.100.7', userAgent: 'Mozilla/5.0' }

describe('aceite dos Termos como condição de publicar', () => {
  it('recusa quem nunca aceitou', async () => {
    const { svc } = service({ user: { termsVersion: '' } })
    await expect(svc.update('u1', { ...completo, truthDeclared: true })).rejects.toThrow(
      /Termos de Uso foram atualizados/,
    )
  })

  it('recusa quem aceitou uma versão antiga', async () => {
    const { svc } = service({ user: { termsVersion: '2020-01-01' } })
    await expect(svc.update('u1', { ...completo, truthDeclared: true })).rejects.toThrow(
      /Termos de Uso foram atualizados/,
    )
  })

  it('NÃO impede salvar rascunho — travar isso seria prender a conta pelo aceite', async () => {
    const { svc, gravado } = service({ user: { termsVersion: '' } })
    await svc.update('u1', { name: 'Marina', oabNumber: 'OAB/SP 1', published: false })
    expect(gravado[0].published).toBe(false)
  })

  it('deixa publicar quem está em dia', async () => {
    const { svc, gravado } = service()
    await svc.update('u1', { ...completo, truthDeclared: true })
    expect(gravado[0].published).toBe(true)
  })
})

describe('declaração de veracidade', () => {
  it('a estreia sem declaração é recusada', async () => {
    const { svc } = service()
    await expect(svc.update('u1', completo)).rejects.toThrow(/informações do perfil são verdadeiras/)
  })

  it('"true" em texto não vale como declaração', async () => {
    const { svc } = service()
    await expect(svc.update('u1', { ...completo, truthDeclared: 'true' })).rejects.toThrow(
      /informações do perfil são verdadeiras/,
    )
  })

  it('carimba data e versão do documento na estreia', async () => {
    const { svc, gravado } = service()
    await svc.update('u1', { ...completo, truthDeclared: true })
    expect(gravado[0].truthDeclaredAt).toBeInstanceOf(Date)
    expect(gravado[0].truthDeclaredVersion).toBe(TERMS_VERSION)
  })

  it('perfil JÁ público salva sem declarar de novo — e não recarimba', async () => {
    // Repetir a confirmação a cada save com debounce transformaria a declaração
    // num reflexo. E recarimbar apagaria a data em que a pessoa de fato declarou.
    const { svc, gravado } = service({ published: true })
    await svc.update('u1', completo)
    expect(gravado[0].published).toBe(true)
    expect(gravado[0].truthDeclaredAt).toBeUndefined()
  })

  it('faltar nome ou OAB é dito ANTES de pedir a declaração', async () => {
    // Mandar declarar veracidade para depois avisar que o perfil está vazio
    // seriam duas viagens para o mesmo destino.
    const { svc } = service()
    await expect(svc.update('u1', { name: '', oabNumber: '', published: true })).rejects.toThrow(
      /falta preencher/,
    )
  })
})

describe('registro de acesso na publicação (Marco Civil, art. 15)', () => {
  it('a estreia grava uma linha com o endereço', async () => {
    const { svc, acessos } = service()
    await svc.update('u1', { ...completo, truthDeclared: true }, origem)
    expect(acessos).toHaveLength(1)
    expect(acessos[0]).toMatchObject({ userId: 'u1', action: 'publicacao', ip: '198.51.100.7' })
  })

  it('salvar RASCUNHO não gera registro — nada foi ao mundo', async () => {
    const { svc, acessos } = service()
    await svc.update('u1', { name: 'Marina', oabNumber: 'OAB/SP 1', published: false }, origem)
    expect(acessos).toHaveLength(0)
  })

  it('sem origem (chamada interna ou teste) não inventa endereço', async () => {
    const { svc, acessos } = service()
    await svc.update('u1', { ...completo, truthDeclared: true })
    expect(acessos).toHaveLength(0)
  })
})
