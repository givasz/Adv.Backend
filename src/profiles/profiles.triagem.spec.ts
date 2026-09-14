// O ASSISTENTE DE TRIAGEM VISTO DO SERVIDOR.
//
// Três perguntas, e as três são de segurança:
//   1. quem não é Max consegue gravar uma triagem? (não, e nem por corpo forjado)
//   2. descer de plano apaga a triagem montada? (não — esconde, como vídeo e marca)
//   3. dá para publicar uma pergunta que pede senha ou cartão? (não, nunca)
//
// Prisma é dublê: o que se verifica é o que o serviço MANDOU gravar.

import { describe, expect, it, vi } from 'vitest'
import { ProfilesService } from './profiles.service'
import { TERMS_VERSION } from '../legal/termos'

type Qualquer = Record<string, any>

interface Opcoes {
  plan?: 'free' | 'pro' | 'premium'
  triageEnabled?: boolean
  triageQuestions?: string
}

function service(o: Opcoes = {}) {
  const linha = {
    id: 'p1',
    userId: 'u1',
    moderationStatus: 'active',
    plan: o.plan ?? 'premium',
    planStatus: 'active',
    currentPeriodEnd: null,
    graceUntil: null,
    planScheduled: null,
    slugGraceUntil: null,
    oabNumber: 'OAB/SP 123',
    name: 'Marina Sales',
    slug: 'marina-sales',
    headline: '',
    bio: '',
    theme: 'papel',
    schedulingMode: 'assistant',
    assistantDays: '[]',
    assistantBusy: '[]',
    triageEnabled: o.triageEnabled ?? false,
    triageQuestions: o.triageQuestions ?? '[]',
    videoUrl: null,
    videoCaption: '',
    card: '',
    brandName: null,
    brandAccent: null,
    brandHideWatermark: false,
    customDomain: null,
    areas: [],
    faqs: [],
    socials: [],
    published: true,
    policyRevChecked: 0,
    truthDeclaredAt: new Date(),
    // Publicar exige o aceite VIGENTE dos Termos — sem isto, todo teste que
    // publica morre no portão anterior e nunca chega à triagem.
    user: { termsVersion: TERMS_VERSION },
  }

  const gravado: Qualquer[] = []
  const prisma: Qualquer = {
    profile: {
      findUnique: vi.fn((a: Qualquer) => {
        if (a?.where?.slug !== undefined) {
          return Promise.resolve(a.where.slug === linha.slug ? { userId: 'u1' } : null)
        }
        return Promise.resolve({ ...linha })
      }),
      findFirst: vi.fn(() => Promise.resolve({ ...linha })),
      update: vi.fn((a: Qualquer) => {
        gravado.push(a.data)
        return Promise.resolve({ ...linha, ...a.data, areas: [], faqs: [], socials: [] })
      }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    linkEvent: { create: vi.fn(() => ({ catch: () => undefined })) },
  }
  return { svc: new ProfilesService(prisma as any), gravado, linha }
}

const base = { name: 'Marina Sales', oabNumber: 'OAB/SP 123', published: false }

const TRIAGEM = {
  enabled: true,
  questions: [
    { id: 'q1', kind: 'escolha', label: 'Qual assunto?', options: ['Família', 'Cível'] },
    { id: 'q2', kind: 'sim-nao', label: 'Já possui processo?' },
  ],
}

// ---------------------------------------------------------------------------

describe('a triagem é do Max, e a trava está no servidor', () => {
  it('Max grava as perguntas, na ordem', async () => {
    const { svc, gravado } = service({ plan: 'premium' })
    await svc.update('u1', { ...base, triage: TRIAGEM })
    expect(gravado[0].triageEnabled).toBe(true)
    expect(JSON.parse(gravado[0].triageQuestions).map((q: Qualquer) => q.id)).toEqual(['q1', 'q2'])
  })

  // As perguntas que o assistente faz sozinho (dia e horário, formato, nome) são
  // do advogado tirar. Só as três: a abertura e o envio não existem nesta lista,
  // e um valor inventado não entra.
  it('Max grava as etapas tiradas da conversa, e elas voltam na resposta', async () => {
    const { svc, gravado } = service({ plan: 'premium' })
    const salvo: Qualquer = await svc.update('u1', {
      ...base,
      triage: { ...TRIAGEM, semEtapas: ['nome', 'abertura', 'horario', 'nome'] },
    })
    expect(JSON.parse(gravado[0].triageSkipSteps)).toEqual(['horario', 'nome'])
    expect(salvo.triage.semEtapas).toEqual(['horario', 'nome'])
  })

  it('sem nada tirado, a coluna grava lista vazia e a resposta não traz o campo', async () => {
    const { svc, gravado } = service({ plan: 'premium' })
    const salvo: Qualquer = await svc.update('u1', { ...base, triage: TRIAGEM })
    expect(gravado[0].triageSkipSteps).toBe('[]')
    expect(salvo.triage).not.toHaveProperty('semEtapas')
  })

  // Corpo forjado por uma conta Pro: a tela nem mostra a seção, mas um PUT
  // montado à mão mostraria. As colunas não entram no update — nada é gravado.
  it('Pro e Free não gravam triagem nenhuma, mesmo com o corpo forjado', async () => {
    for (const plan of ['free', 'pro'] as const) {
      const { svc, gravado } = service({ plan })
      await svc.update('u1', { ...base, triage: TRIAGEM })
      expect(gravado[0]).not.toHaveProperty('triageEnabled')
      expect(gravado[0]).not.toHaveProperty('triageQuestions')
    }
  })

  it('rebaixar ESCONDE, nunca apaga — a triagem montada sobrevive ao save no Pro', async () => {
    const { svc, gravado } = service({
      plan: 'pro',
      triageEnabled: true,
      triageQuestions: JSON.stringify(TRIAGEM.questions),
    })
    await svc.update('u1', { ...base })
    expect(gravado[0]).not.toHaveProperty('triageQuestions')
  })

  it('fora do Max a triagem some da RESPOSTA — a conversa pública volta ao agendamento', async () => {
    const { svc } = service({
      plan: 'pro',
      triageEnabled: true,
      triageQuestions: JSON.stringify(TRIAGEM.questions),
    })
    const salvo: Qualquer = await svc.update('u1', { ...base })
    expect(salvo.triage).toBeUndefined()
  })

  it('no Max a triagem sai na resposta, já normalizada', async () => {
    const { svc } = service({ plan: 'premium' })
    const salvo: Qualquer = await svc.update('u1', { ...base, triage: TRIAGEM })
    expect(salvo.triage.enabled).toBe(true)
    expect(salvo.triage.questions).toHaveLength(2)
  })
})

describe('o que o servidor recusa gravar', () => {
  const pedido = (label: string) => ({
    ...base,
    triage: { enabled: true, questions: [{ id: 'q1', kind: 'texto', label }] },
  })

  it.each([
    'Qual a senha do seu banco?',
    'Digite o código de confirmação',
    'Informe o número do cartão de crédito',
    'Qual a sua conta bancária?',
  ])('recusa: %s', async (label) => {
    const { svc, gravado } = service({ plan: 'premium' })
    await expect(svc.update('u1', pedido(label))).rejects.toThrow(/pergunta/i)
    expect(gravado).toHaveLength(0)
  })

  it('a recusa diz o que está errado e oferece uma reescrita', async () => {
    const { svc } = service({ plan: 'premium' })
    await expect(svc.update('u1', pedido('Qual a sua senha?'))).rejects.toThrow(/Sugestão/)
  })

  it('CPF, saúde e renda AVISAM na tela, mas gravam — a decisão é do advogado', async () => {
    for (const label of ['Qual o seu CPF?', 'Qual seu diagnóstico?', 'Qual seu salário?']) {
      const { svc, gravado } = service({ plan: 'premium' })
      await svc.update('u1', pedido(label))
      expect(JSON.parse(gravado[0].triageQuestions)[0].label).toBe(label)
    }
  })

  it('pergunta com termo vedado pela OAB não publica', async () => {
    const { svc } = service({ plan: 'premium' })
    await expect(
      svc.update('u1', {
        ...base,
        published: true,
        truthDeclared: true,
        triage: {
          enabled: true,
          questions: [{ id: 'q1', kind: 'texto', label: 'Quer sucesso garantido no seu processo?' }],
        },
      }),
    ).rejects.toThrow(/Pergunta da triagem/)
  })

  // O outro lado da moeda: fora do Max a triagem nem é lida, então um texto
  // vedado num corpo forjado não pode travar a publicação de quem nunca teria
  // aquela pergunta no ar.
  it('no Pro, triagem forjada com texto vedado não impede publicar', async () => {
    const { svc, gravado } = service({ plan: 'pro' })
    await svc.update('u1', {
      ...base,
      published: true,
      triage: {
        enabled: true,
        questions: [{ id: 'q1', kind: 'texto', label: 'Sucesso garantido no seu processo?' }],
      },
    })
    expect(gravado).toHaveLength(1)
  })
})

describe('nenhuma resposta de visitante passa por aqui', () => {
  it('o que é gravado tem só pergunta, tipo e opções', async () => {
    const { svc, gravado } = service({ plan: 'premium' })
    await svc.update('u1', {
      ...base,
      triage: {
        enabled: true,
        questions: [
          {
            id: 'q1',
            kind: 'escolha',
            label: 'Qual assunto?',
            options: ['Família'],
            // Um corpo forjado tentando pendurar resposta de visitante na coluna.
            respostas: [{ nome: 'Ana', texto: 'meu caso é...' }],
            answers: ['x'],
          },
        ],
      },
    })
    const [q] = JSON.parse(gravado[0].triageQuestions)
    expect(Object.keys(q).sort()).toEqual(['id', 'kind', 'label', 'options'])
  })
})
