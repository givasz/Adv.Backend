// Quem escreve o texto quando o advogado pede ajuda à IA — e o que acontece
// quando esse alguém para de responder.
//
// ---------------------------------------------------------------------------
// O PROBLEMA
//
// Até 31/08/2026 havia UM provedor, escolhido por `AI_PROVIDER`, com UMA chave.
// O tier grátis do Gemini estoura a cota diária, a chave é revogada, o provedor
// tem incidente — e o botão "Gerar com IA" simplesmente para de funcionar para
// todo mundo, sem nada a fazer além de editar o `.env` da VPS e reiniciar.
// Recurso de plano pago dependendo de uma chave só, sem plano B.
//
// A resposta é uma CADEIA: `AI_PROVIDER` aceita lista.
//
//     AI_PROVIDER=gemini,groq,openrouter
//
// O primeiro que tiver chave e responder ganha. Quem falha passa a vez.
//
// E cada provedor aceita VÁRIAS CHAVES, separadas por vírgula:
//
//     GEMINI_API_KEY=chave-principal,chave-reserva-1,chave-reserva-2
//
// Cota estourada (429) ou chave recusada (401/403) rodam para a próxima chave
// DO MESMO provedor antes de desistir dele — e a posição fica guardada, para a
// chave queimada não ser tentada de novo a cada pedido.
//
// ---------------------------------------------------------------------------
// POR QUE ISSO É SEGURO COM MODELO PIOR
//
// Porque a conformidade não depende do modelo. O texto gerado passa pela mesma
// checagem da OAB, pelo mesmo laço de reparo dirigido e, no fim da fila, pelo
// mesmo template garantidamente regular (ver ai.service.ts e oab/compliance.ts).
// Um modelo de reserva mais fraco produz texto mais sem graça — nunca texto
// irregular. É o que torna a cadeia uma decisão de disponibilidade, e não uma
// aposta de conformidade.
// ---------------------------------------------------------------------------

export type Provider = 'gemini' | 'groq' | 'openrouter' | 'xai' | 'anthropic' | 'ollama'

export interface Provedor {
  nome: Provider
  /**
   * Variáveis onde a chave pode estar, na ordem em que são procuradas. A
   * PRIMEIRA preenchida vale — e o valor dela pode ser uma lista.
   */
  envs: string[]
  /** Modelo usado quando nada é declarado. */
  modeloPadrao: string
  /**
   * Endereço da API compatível com a da OpenAI (`/chat/completions`).
   * Ausente quer dizer que o provedor tem caminho próprio no ai.service.
   */
  baseOpenAi?: string
  /** Roda sem chave nenhuma — só o LLM local. */
  semChave?: boolean
  /** Como está a gratuidade hoje. Só documentação: nada no código lê isto. */
  custo: 'gratis' | 'credito-de-teste' | 'local' | 'pago'
  /**
   * O provedor pode TREINAR com o que mandamos?
   *
   * -------------------------------------------------------------------------
   * POR QUE ESTE CAMPO EXISTE (auditoria de 01/09/2026)
   *
   * A Política de IA publicada em /legal/ia afirma, sem ressalva:
   *
   *     "Não usamos os seus dados para treinar modelos de terceiros."
   *
   * E o que sai daqui não é anônimo: vai o NOME do advogado (headline e bio), a
   * CIDADE/UF e as ÁREAS no plano Max, e o TEXTO QUE ELE JÁ ESCREVEU (bio ou
   * resposta de FAQ, até 2000 caracteres) quando ele pede para melhorar.
   *
   * Essa promessa não é nossa para cumprir sozinhos: quem decide se treina é o
   * provedor, nos termos DELE. E a cadeia montada hoje é feita de tier grátis —
   * que é, historicamente, onde os provedores se reservam esse direito, e é
   * justamente o que se troca pelo preço zero. O próprio catálogo abaixo já
   * dizia isso de um deles em voz alta ("crédito mensal em troca de deixar a
   * xAI treinar com o tráfego") sem que nada no código levasse o fato em conta.
   *
   * Então o fato passa a ser um campo, e não um comentário: quem monta
   * `AI_PROVIDER` vê o que está escolhendo, e `avisarSobreTreinoDeIa()` reclama
   * no boot quando a cadeia configurada contradiz a política publicada.
   *
   * ⚠️ NÃO é um bloqueio. Derrubar a IA em produção por causa disto seria trocar
   * um problema de privacidade por uma indisponibilidade — e a decisão de qual
   * provedor é aceitável é de quem responde pela plataforma, não do código. O
   * código informa; a escolha continua sendo humana.
   *
   * ⚠️ Como `custo`, isto ENVELHECE: é termo de terceiro e muda sem aviso.
   * Confira no contrato do provedor antes de confiar. Conferido em 01/09/2026.
   * -------------------------------------------------------------------------
   *
   *   'nao'    — o contrato diz que não treina com o que entra pela API.
   *   'talvez' — depende do tier ou de uma opção da conta. Trate como 'sim'
   *              até alguém ler o contrato daquela conta e concluir o contrário.
   *   'local'  — não sai da nossa máquina; não há terceiro nenhum.
   */
  treinaComOsDados: 'nao' | 'talvez' | 'local'
}

/**
 * O catálogo.
 *
 * ⚠️ `custo` é a situação conferida em 31/08/2026 e envelhece: tier grátis é
 * decisão de terceiro e muda sem aviso. Ele existe para quem for escolher a
 * cadeia saber o que está escolhendo, não para o código decidir nada.
 */
export const PROVEDORES: Record<Provider, Provedor> = {
  // Google Gemini — o principal hoje. Chave em aistudio.google.com/app/apikey.
  gemini: {
    nome: 'gemini',
    envs: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    modeloPadrao: 'gemini-flash-lite-latest',
    custo: 'gratis',
    // O tier grátis do Gemini (chave do AI Studio) e o pago tratam o conteúdo de
    // forma diferente — o grátis é o que se paga com os dados. Confira o termo
    // vigente da SUA chave antes de tratar como 'nao'.
    treinaComOsDados: 'talvez',
  },
  // GroqCloud (console.groq.com) — NÃO é o Grok da xAI, apesar do nome.
  // É o melhor reserva que existe hoje: tier grátis de verdade, sem cartão,
  // limitado por taxa (dezenas de pedidos por minuto) e absurdamente rápido.
  groq: {
    nome: 'groq',
    envs: ['GROQ_API_KEY'],
    baseOpenAi: 'https://api.groq.com/openai/v1',
    modeloPadrao: 'llama-3.3-70b-versatile',
    custo: 'gratis',
    treinaComOsDados: 'talvez',
  },
  // OpenRouter (openrouter.ai) — um endereço, dezenas de modelos, e um punhado
  // deles com sufixo ":free". Reserva do reserva: se um modelo grátis sai do ar,
  // troca-se só o nome do modelo, sem tocar em código.
  //
  // ⚠️ A lista de modelos ":free" RODA. Confira antes de fixar um:
  //     curl -s https://openrouter.ai/api/v1/models | grep -o '"id":"[^"]*:free"'
  openrouter: {
    nome: 'openrouter',
    envs: ['OPENROUTER_API_KEY'],
    baseOpenAi: 'https://openrouter.ai/api/v1',
    modeloPadrao: 'google/gemma-4-31b-it:free',
    custo: 'gratis',
    // Os modelos ":free" do OpenRouter costumam vir atrelados a uma opção de
    // compartilhar o tráfego — é o que os torna grátis. Um modelo PAGO do mesmo
    // OpenRouter não tem a mesma condição: aqui o que decide é o modelo, não só
    // o provedor.
    treinaComOsDados: 'talvez',
  },
  // xAI — o Grok de verdade (console.x.ai). Entra aqui porque foi pedido, mas
  // com o aviso: ele NÃO tem tier grátis permanente. O que existe é crédito de
  // teste na abertura da conta (e, em algumas janelas, crédito mensal em troca
  // de deixar a xAI treinar com o tráfego). Quando o crédito acaba, é pago.
  // Como reserva de verdade, prefira o groq acima.
  xai: {
    nome: 'xai',
    envs: ['XAI_API_KEY', 'GROK_API_KEY'],
    baseOpenAi: 'https://api.x.ai/v1',
    // ⚠️ Confira o nome vigente no console da xAI antes de contar com ele: a
    // família "grok-4-fast" troca de sufixo com frequência. Sobrescreva com
    // AI_MODEL_XAI sem mexer em código.
    modeloPadrao: 'grok-4-fast-non-reasoning',
    custo: 'credito-de-teste',
    // O próprio comentário acima já dizia: em algumas janelas o crédito mensal é
    // dado EM TROCA de deixar a xAI treinar com o tráfego.
    treinaComOsDados: 'talvez',
  },
  // Claude — pago, e é por isso que ele NUNCA entra na cadeia sozinho: ninguém
  // deve descobrir que a cota grátis acabou pela fatura.
  anthropic: {
    nome: 'anthropic',
    envs: ['ANTHROPIC_API_KEY'],
    modeloPadrao: 'claude-sonnet-5',
    custo: 'pago',
    // O termo da API paga da Anthropic não treina com o que entra pela API. É o
    // único da lista que sustenta a promessa de /legal/ia sem ressalva — e custa
    // dinheiro, que é exatamente a troca.
    treinaComOsDados: 'nao',
  },
  // LLM local (desenvolvimento). Sem chave e sem custo — mas só existe onde o
  // Ollama estiver rodando, então na VPS ele nunca deveria ser o primeiro.
  ollama: {
    nome: 'ollama',
    envs: [],
    modeloPadrao: 'llama3.2:3b',
    semChave: true,
    custo: 'local',
    // Não sai da máquina: não há terceiro para treinar com nada.
    treinaComOsDados: 'local',
  },
}

const NOMES = Object.keys(PROVEDORES) as Provider[]

/** A cadeia usada quando `AI_PROVIDER` não diz nada. */
export const CADEIA_PADRAO: Provider[] = ['anthropic']

/**
 * As chaves de um provedor, em ordem de uso.
 *
 * Aceita lista separada por vírgula OU por espaço/quebra de linha: a chave é
 * copiada e colada do console do provedor, e um `.env` com três delas numa linha
 * só é exatamente onde um espaço sobra sem ninguém ver.
 */
export function lerChaves(env: NodeJS.ProcessEnv, p: Provider): string[] {
  const def = PROVEDORES[p]
  if (!def) return []
  for (const nome of def.envs) {
    const bruto = (env[nome] ?? '').trim()
    if (!bruto) continue
    const chaves = [...new Set(bruto.split(/[,\s]+/).map((c) => c.trim()).filter(Boolean))]
    if (chaves.length) return chaves
  }
  return []
}

/**
 * A cadeia PEDIDA em `AI_PROVIDER`, saneada: nomes desconhecidos somem, repetido
 * conta uma vez, ordem preservada. Vazia ou toda inválida cai no padrão.
 */
export function cadeiaConfigurada(env: NodeJS.ProcessEnv): Provider[] {
  const bruto = (env.AI_PROVIDER ?? '').split(/[,\s]+/).map((s) => s.trim().toLowerCase())
  const cadeia = [...new Set(bruto)].filter((n): n is Provider =>
    (NOMES as string[]).includes(n),
  )
  return cadeia.length ? cadeia : [...CADEIA_PADRAO]
}

/**
 * A cadeia que dá para USAR agora: a pedida, menos quem não tem chave.
 *
 * Filtrar aqui, e não na hora de chamar, é o que faz a mensagem de erro ser
 * "nenhum provedor configurado" em vez de três falhas de autenticação em
 * sequência — e é o que permite deixar `AI_PROVIDER=gemini,groq,openrouter`
 * escrito no `.env` desde já, com as chaves de reserva chegando depois.
 */
export function cadeiaUtil(env: NodeJS.ProcessEnv): Provider[] {
  return cadeiaConfigurada(env).filter(
    (p) => PROVEDORES[p].semChave || lerChaves(env, p).length > 0,
  )
}

/**
 * Provedores da cadeia atual que PODEM treinar com o que mandamos.
 *
 * Vazio é o estado que a Política de IA descreve; qualquer outra coisa é uma
 * diferença entre o que está publicado e o que está configurado.
 */
export function provedoresQueTreinam(env: NodeJS.ProcessEnv): Provider[] {
  return cadeiaUtil(env).filter((p) => PROVEDORES[p].treinaComOsDados === 'talvez')
}

/**
 * Aviso de boot: a cadeia configurada sustenta o que /legal/ia promete?
 *
 * A política diz "Não usamos os seus dados para treinar modelos de terceiros", e
 * o que sai daqui tem nome, cidade e o texto que o advogado escreveu. Quando a
 * cadeia tem um provedor de tier grátis, essa frase depende de um contrato de
 * terceiro que ninguém conferiu — e uma promessa de privacidade que a
 * configuração não sustenta é pior do que não ter feito a promessa.
 *
 * AVISA, não derruba. Bloquear aqui trocaria um problema de privacidade por uma
 * indisponibilidade, e qual provedor é aceitável é decisão de quem responde pela
 * plataforma. O código põe o fato na frente de quem decide; a escolha é humana.
 *
 * `AI_TREINO_CIENTE=1` cala o aviso — para quem leu o contrato da própria chave
 * e concluiu que está tudo certo. É opt-in explícito, e não o padrão, porque o
 * silêncio por padrão é como esta diferença passou despercebida até aqui.
 */
export function avisarSobreTreinoDeIa(
  env: NodeJS.ProcessEnv = process.env,
  avisar: (msg: string) => void = console.warn,
): void {
  if (env.AI_TREINO_CIENTE === '1' || env.AI_TREINO_CIENTE === 'true') return
  const treinam = provedoresQueTreinam(env)
  if (!treinam.length) return
  avisar(
    `[privacidade] A cadeia de IA usa ${treinam.join(', ')} — tier em que o provedor ` +
      'pode treinar com o que enviamos (nome, cidade e o texto do advogado).\n' +
      '  /legal/ia promete "Não usamos os seus dados para treinar modelos de terceiros".\n' +
      '  Confira o contrato da sua chave. Se estiver certo, AI_TREINO_CIENTE=1 cala este aviso;\n' +
      '  se não, troque a cadeia (ver treinaComOsDados em ai/provedores.ts) ou ajuste a política.',
  )
}

/**
 * O modelo de um provedor.
 *
 * Precedência, da mais específica para a mais geral:
 *   1. `AI_MODEL_<PROVEDOR>` — ex.: AI_MODEL_GROQ. É como se declara o modelo
 *      de cada elo da cadeia, e o único jeito que funciona com mais de um.
 *   2. `AI_MODEL` — mas SÓ para o primeiro da cadeia. Era a variável de quando
 *      existia um provedor só, e ela continua querendo dizer a mesma coisa:
 *      "o modelo do provedor principal". Aplicá-la aos reservas mandaria
 *      "gemini-flash-lite-latest" para o Groq, que não conhece esse nome.
 *   3. O padrão do catálogo.
 */
export function modeloDe(env: NodeJS.ProcessEnv, p: Provider, principal: boolean): string {
  const especifico = (env[`AI_MODEL_${p.toUpperCase()}`] ?? '').trim()
  if (especifico) return especifico
  const geral = (env.AI_MODEL ?? '').trim()
  if (principal && geral) return geral
  return PROVEDORES[p].modeloPadrao
}

/**
 * Este erro é da CHAVE, e não do provedor?
 *
 * 401/403 é chave recusada; 429 é cota estourada. Nos três, a próxima chave do
 * mesmo provedor tem chance real de funcionar. Qualquer outra coisa — 500, 503,
 * rede caída, resposta vazia — é problema do provedor, e trocar de chave só
 * gastaria as reservas à toa.
 */
export function chaveQueimada(status: number, detalhe = ''): boolean {
  if (status === 401 || status === 403 || status === 429) return true
  // O Google recusa chave inválida com 400, não com 401 — medido contra a API
  // com uma chave falsa: `400 { "reason": "API_KEY_INVALID" }`. Sem olhar o
  // corpo, a chave reserva do Gemini nunca seria tentada, que é justamente o
  // caso para o qual ela existe.
  return status === 400 && MARCAS_DE_CHAVE.test(detalhe)
}

/**
 * O que, num corpo de erro 400, denuncia problema de CHAVE e não de pedido.
 *
 * Deliberadamente curto: um 400 quase sempre é pedido malformado (nome de
 * modelo errado, campo faltando), e nesse caso trocar de chave só queimaria as
 * reservas sem chance nenhuma de dar certo.
 */
const MARCAS_DE_CHAVE =
  /api[_ -]?key[_ -]?invalid|invalid[_ -]?api[_ -]?key|incorrect api key|api key not valid|quota|rate.?limit/i

/** Erro de um provedor, carregando o status HTTP para a decisão acima. */
export class ErroDeProvedor extends Error {
  constructor(
    readonly provedor: Provider,
    readonly status: number,
    motivo: string,
  ) {
    super(`${provedor}: ${motivo}`)
    this.name = 'ErroDeProvedor'
  }
}

/**
 * Girador de chaves — lembra qual chave de cada provedor está valendo.
 *
 * Vive em memória de propósito: é preferência de execução, não dado. Reiniciar
 * o processo volta para a primeira chave, que é o comportamento certo — a cota
 * diária do Gemini vira à meia-noite, e insistir para sempre na terceira chave
 * porque a primeira falhou ontem seria pior.
 */
export class GiroDeChaves {
  private readonly atual = new Map<Provider, number>()

  /** A chave que vale agora para este provedor. */
  chave(p: Provider, chaves: string[]): string {
    if (!chaves.length) return ''
    return chaves[(this.atual.get(p) ?? 0) % chaves.length]
  }

  /** Passa para a próxima. Devolve `false` quando já deu a volta inteira. */
  girar(p: Provider, total: number, jaTentadas: number): boolean {
    if (total <= 1 || jaTentadas >= total) return false
    this.atual.set(p, ((this.atual.get(p) ?? 0) + 1) % total)
    return true
  }

  /** Índice atual — só para log e teste. */
  indice(p: Provider): number {
    return this.atual.get(p) ?? 0
  }
}
