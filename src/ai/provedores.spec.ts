import { describe, expect, it } from 'vitest'
import {
  CADEIA_PADRAO,
  cadeiaConfigurada,
  cadeiaUtil,
  chaveQueimada,
  GiroDeChaves,
  lerChaves,
  modeloDe,
  PROVEDORES,
  provedoresQueTreinam,
  avisarSobreTreinoDeIa,
  type Provider,
} from './provedores'

// A cadeia de provedores existe para UMA coisa: o botão "Gerar com IA" não pode
// morrer porque uma cota diária estourou. Os testes abaixo são dessa promessa.

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv

describe('lerChaves', () => {
  it('lê uma chave só', () => {
    expect(lerChaves(env({ GEMINI_API_KEY: 'k1' }), 'gemini')).toEqual(['k1'])
  })

  it('lê a lista de reservas separada por vírgula', () => {
    expect(lerChaves(env({ GEMINI_API_KEY: 'k1,k2,k3' }), 'gemini')).toEqual(['k1', 'k2', 'k3'])
  })

  it('aguenta espaço e quebra de linha entre as chaves', () => {
    // Três chaves copiadas do console e coladas no .env é exatamente onde sobra
    // um espaço que ninguém vê.
    expect(lerChaves(env({ GROQ_API_KEY: ' k1 ,  k2\n k3 ' }), 'groq')).toEqual(['k1', 'k2', 'k3'])
  })

  it('não repete a mesma chave colada duas vezes', () => {
    expect(lerChaves(env({ GROQ_API_KEY: 'k1,k1,k2' }), 'groq')).toEqual(['k1', 'k2'])
  })

  it('cai na segunda variável quando a primeira está vazia', () => {
    // O Gemini aceita GEMINI_API_KEY ou GOOGLE_API_KEY, nessa ordem.
    expect(lerChaves(env({ GEMINI_API_KEY: '  ', GOOGLE_API_KEY: 'k9' }), 'gemini')).toEqual(['k9'])
  })

  it('sem nada configurado, devolve lista vazia em vez de estourar', () => {
    expect(lerChaves(env({}), 'gemini')).toEqual([])
    expect(lerChaves(env({}), 'ollama')).toEqual([])
  })
})

describe('cadeiaConfigurada', () => {
  it('aceita a lista, na ordem escrita', () => {
    expect(cadeiaConfigurada(env({ AI_PROVIDER: 'gemini,groq,openrouter' }))).toEqual([
      'gemini',
      'groq',
      'openrouter',
    ])
  })

  it('continua entendendo um provedor só — era o formato antigo', () => {
    expect(cadeiaConfigurada(env({ AI_PROVIDER: 'gemini' }))).toEqual(['gemini'])
  })

  it('descarta nome desconhecido em vez de derrubar o serviço', () => {
    expect(cadeiaConfigurada(env({ AI_PROVIDER: 'gemini,chatgpt,groq' }))).toEqual([
      'gemini',
      'groq',
    ])
  })

  it('repetido conta uma vez', () => {
    expect(cadeiaConfigurada(env({ AI_PROVIDER: 'groq,groq' }))).toEqual(['groq'])
  })

  it('vazio ou só lixo cai no padrão', () => {
    expect(cadeiaConfigurada(env({}))).toEqual(CADEIA_PADRAO)
    expect(cadeiaConfigurada(env({ AI_PROVIDER: '  ' }))).toEqual(CADEIA_PADRAO)
    expect(cadeiaConfigurada(env({ AI_PROVIDER: 'inventado' }))).toEqual(CADEIA_PADRAO)
  })
})

describe('cadeiaUtil', () => {
  it('tira da fila quem não tem chave', () => {
    // Deixar a cadeia inteira escrita no .env desde já, com as reservas
    // chegando depois, tem de ser inofensivo.
    const chain = cadeiaUtil(
      env({ AI_PROVIDER: 'gemini,groq,openrouter', GEMINI_API_KEY: 'k1', GROQ_API_KEY: 'k2' }),
    )
    expect(chain).toEqual(['gemini', 'groq'])
  })

  it('o ollama entra sem chave nenhuma — ele é local', () => {
    expect(cadeiaUtil(env({ AI_PROVIDER: 'gemini,ollama' }))).toEqual(['ollama'])
  })

  it('sem nenhuma chave, a cadeia fica vazia e o serviço sabe dizer isso', () => {
    expect(cadeiaUtil(env({ AI_PROVIDER: 'gemini,groq' }))).toEqual([])
  })
})

describe('modeloDe', () => {
  it('usa o padrão do catálogo quando nada é declarado', () => {
    expect(modeloDe(env({}), 'groq', false)).toBe(PROVEDORES.groq.modeloPadrao)
  })

  it('AI_MODEL_<PROVEDOR> manda em qualquer posição da cadeia', () => {
    const e = env({ AI_MODEL_GROQ: 'llama-3.1-8b-instant' })
    expect(modeloDe(e, 'groq', false)).toBe('llama-3.1-8b-instant')
    expect(modeloDe(e, 'groq', true)).toBe('llama-3.1-8b-instant')
  })

  it('AI_MODEL vale SÓ para o principal', () => {
    // É a armadilha que este teste existe para travar: AI_MODEL era a variável
    // de quando havia um provedor só. Aplicá-la à cadeia inteira mandaria
    // "gemini-flash-lite-latest" para o Groq, que não conhece esse nome — e a
    // reserva falharia justamente no dia em que ela precisasse funcionar.
    const e = env({ AI_MODEL: 'gemini-flash-lite-latest' })
    expect(modeloDe(e, 'gemini', true)).toBe('gemini-flash-lite-latest')
    expect(modeloDe(e, 'groq', false)).toBe(PROVEDORES.groq.modeloPadrao)
  })

  it('o específico ganha do geral', () => {
    const e = env({ AI_MODEL: 'geral', AI_MODEL_GEMINI: 'especifico' })
    expect(modeloDe(e, 'gemini', true)).toBe('especifico')
  })
})

describe('chaveQueimada', () => {
  it('cota estourada e chave recusada pedem a próxima chave', () => {
    expect(chaveQueimada(429)).toBe(true)
    expect(chaveQueimada(401)).toBe(true)
    expect(chaveQueimada(403)).toBe(true)
  })

  it('provedor fora do ar NÃO gasta as reservas — pede o próximo provedor', () => {
    for (const status of [0, 400, 404, 500, 503]) expect(chaveQueimada(status)).toBe(false)
  })

  it('chave inválida do Google chega como 400 — e o corpo é quem denuncia', () => {
    // Medido contra a API com uma chave falsa: o Google responde
    //   400 { "message": "API key not valid...", "reason": "API_KEY_INVALID" }
    // Sem olhar o corpo, a chave reserva do Gemini nunca seria tentada — que é
    // exatamente o caso para o qual ela existe.
    const corpo = 'respondeu 400 {"error":{"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}'
    expect(chaveQueimada(400, corpo)).toBe(true)
  })

  it('mas um 400 comum continua sendo problema de pedido, não de chave', () => {
    // Nome de modelo errado é o 400 mais provável de todos. Girar a chave aqui
    // queimaria as reservas sem uma única chance de dar certo.
    expect(chaveQueimada(400, 'respondeu 400 {"error":"model not found: llama-9"}')).toBe(false)
    expect(chaveQueimada(400)).toBe(false)
  })
})

describe('GiroDeChaves', () => {
  it('começa na primeira chave', () => {
    const g = new GiroDeChaves()
    expect(g.chave('gemini', ['a', 'b', 'c'])).toBe('a')
  })

  it('gira e LEMBRA — a chave queimada não é tentada de novo a cada pedido', () => {
    const g = new GiroDeChaves()
    g.girar('gemini', 3, 1)
    expect(g.chave('gemini', ['a', 'b', 'c'])).toBe('b')
    g.girar('gemini', 3, 1)
    expect(g.chave('gemini', ['a', 'b', 'c'])).toBe('c')
  })

  it('não gira quando há uma chave só', () => {
    const g = new GiroDeChaves()
    expect(g.girar('groq', 1, 1)).toBe(false)
  })

  it('para depois de dar a volta inteira, em vez de rodar para sempre', () => {
    const g = new GiroDeChaves()
    expect(g.girar('groq', 3, 1)).toBe(true)
    expect(g.girar('groq', 3, 2)).toBe(true)
    expect(g.girar('groq', 3, 3)).toBe(false)
  })

  it('cada provedor tem o próprio giro', () => {
    const g = new GiroDeChaves()
    g.girar('gemini', 2, 1)
    expect(g.indice('gemini')).toBe(1)
    expect(g.indice('groq')).toBe(0)
  })
})

describe('o catálogo', () => {
  it('todo provedor com chave declara onde ela mora', () => {
    for (const [nome, def] of Object.entries(PROVEDORES)) {
      if (def.semChave) continue
      expect(def.envs.length, `${nome} sem variável de chave`).toBeGreaterThan(0)
    }
  })

  it('quem não tem caminho próprio no serviço precisa de endereço compatível', () => {
    // groq, xai e openrouter dividem a mesma função (viaOpenAiCompativel); sem
    // `baseOpenAi` ela chamaria `undefined/chat/completions`.
    const proprios: Provider[] = ['gemini', 'anthropic', 'ollama']
    for (const [nome, def] of Object.entries(PROVEDORES)) {
      if (proprios.includes(nome as Provider)) continue
      expect(def.baseOpenAi, `${nome} sem baseOpenAi`).toMatch(/^https:\/\//)
    }
  })

  it('todo provedor tem modelo padrão — nenhum depende do .env para subir', () => {
    for (const [nome, def] of Object.entries(PROVEDORES)) {
      expect(def.modeloPadrao, `${nome} sem modelo padrão`).toBeTruthy()
    }
  })

  it('o padrão NUNCA é um provedor pago sem que alguém tenha pedido', () => {
    // CADEIA_PADRAO só entra quando AI_PROVIDER não diz nada. Se um dia alguém
    // puser aqui um provedor pago sem chave configurada, a conta chega antes do
    // aviso — daí a trava: o padrão tem de ser um provedor só e explícito.
    expect(CADEIA_PADRAO).toHaveLength(1)
  })
})

// O que mandamos para a IA é dado do advogado — e a política publicada faz uma
// promessa sobre ele.
//
// /legal/ia diz: "Não usamos os seus dados para treinar modelos de terceiros".
// O prompt leva o NOME (headline e bio), a CIDADE/UF e as ÁREAS no Max, e o
// TEXTO QUE O ADVOGADO ESCREVEU quando ele pede para melhorar. Quem decide se
// treina é o provedor, no contrato dele — então a promessa depende da cadeia
// configurada, e é isso que estes testes mantêm visível.
describe('treinamento com dados do advogado', () => {
  it('todo provedor declara a própria postura', () => {
    for (const [nome, def] of Object.entries(PROVEDORES)) {
      expect(
        ['nao', 'talvez', 'local'],
        `${nome} não diz se o provedor pode treinar com o que mandamos`,
      ).toContain(def.treinaComOsDados)
    }
  })

  it('o LLM local não conta como terceiro', () => {
    expect(PROVEDORES.ollama.treinaComOsDados).toBe('local')
  })

  it('avisa quando a cadeia configurada contradiz a política publicada', () => {
    const avisos: string[] = []
    avisarSobreTreinoDeIa(
      { AI_PROVIDER: 'gemini,groq', GEMINI_API_KEY: 'k', GROQ_API_KEY: 'k' } as never,
      (m) => avisos.push(m),
    )
    expect(avisos).toHaveLength(1)
    expect(avisos[0]).toContain('gemini')
    expect(avisos[0]).toContain('groq')
    // O aviso precisa dizer o que está em jogo, senão vira ruído que se ignora.
    expect(avisos[0]).toMatch(/nome, cidade e o texto do advogado/)
  })

  it('cala quando a cadeia sustenta a promessa sozinha', () => {
    const avisos: string[] = []
    avisarSobreTreinoDeIa({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' } as never, (m) =>
      avisos.push(m),
    )
    expect(avisos).toEqual([])
  })

  it('provedor sem chave não gera aviso — ele não está na cadeia útil', () => {
    // `AI_PROVIDER` pode listar reservas cuja chave ainda não chegou. Avisar
    // sobre um provedor que nunca vai ser chamado é o começo do aviso ignorado.
    const avisos: string[] = []
    avisarSobreTreinoDeIa(
      { AI_PROVIDER: 'anthropic,openrouter', ANTHROPIC_API_KEY: 'k' } as never,
      (m) => avisos.push(m),
    )
    expect(avisos).toEqual([])
  })

  it('AI_TREINO_CIENTE=1 cala, e é opt-in explícito', () => {
    const avisos: string[] = []
    avisarSobreTreinoDeIa(
      { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'k', AI_TREINO_CIENTE: '1' } as never,
      (m) => avisos.push(m),
    )
    expect(avisos).toEqual([])
  })

  it('provedoresQueTreinam nomeia exatamente quem está em uso', () => {
    const env = { AI_PROVIDER: 'anthropic,gemini', ANTHROPIC_API_KEY: 'k', GEMINI_API_KEY: 'k' }
    expect(provedoresQueTreinam(env as never)).toEqual(['gemini'])
  })
})
