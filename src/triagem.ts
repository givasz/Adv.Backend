// O FORMATO DA TRIAGEM — fonte da verdade do que pode ser gravado.
//
// ⚠️ MANTER EM SINCRONIA com frontend/src/lib/triagem.ts. Os dois lados passam
// pelos mesmos casos (frontend/src/lib/triagem.casos.json) — se só um mudar, a
// tela aceita e o servidor recusa (ou o contrário, que é pior: a tela promete uma
// pergunta que a conversa nunca vai fazer).
//
// O QUE ESTE ARQUIVO GUARDA, E O QUE ELE NÃO GUARDA
//
// Guarda as PERGUNTAS que o advogado escreveu, e o CAMINHO entre elas. Não
// guarda, e não deve passar a guardar, nenhuma RESPOSTA de visitante: o que a
// pessoa responde é montado no aparelho dela e sai direto para o WhatsApp do
// advogado. Não existe coluna, não existe rota e não existe caminho pelo qual
// uma resposta chegue até aqui — é a mesma decisão que tirou a agenda-calendário
// do produto em 21/08/2026.
//
// Conformidade (Prov. 205/2021 + Cartilha do CFOAB): o chatbot é admitido para
// facilitar a comunicação, encaminhar primeiras informações e coletar dados — e
// é vedado usá-lo para RESPONDER consulta jurídica. Por isso a triagem só tem
// perguntas: não há campo de "resposta automática", não há classificação do caso
// e não há IA em lugar nenhum deste caminho. Ramificar não muda isso: quem
// decide para onde cada resposta leva é o advogado, escrevendo, e o assistente
// apenas anda pelo caminho que ele desenhou.

/** Os tipos de pergunta que a triagem entende. */
export type TipoDePergunta =
  | 'texto' // resposta curta, uma linha
  | 'texto-longo' // "conte brevemente o que aconteceu"
  | 'escolha' // uma opção entre várias
  | 'multipla' // quantas quiser entre várias
  | 'sim-nao'
  | 'data'
  | 'atendimento' // presencial ou online — alimenta o "Formato" da mensagem
  | 'contato' // como posso te chamar — alimenta o "Nome" da mensagem

export const TIPOS_DE_PERGUNTA: TipoDePergunta[] = [
  'texto',
  'texto-longo',
  'escolha',
  'multipla',
  'sim-nao',
  'data',
  'atendimento',
  'contato',
]

/** Tipos cuja lista de opções é ESCRITA pelo advogado. */
export const TIPOS_COM_OPCOES: TipoDePergunta[] = ['escolha', 'multipla']

/**
 * Tipos cuja lista é NOSSA e não se edita — mas que têm opções do mesmo jeito,
 * para que ramificar seja um mecanismo só. "Sim" pode levar a uma pergunta e
 * "Não" a outra, exatamente como numa escolha escrita à mão.
 */
export const OPCOES_FIXAS: Partial<Record<TipoDePergunta, { id: string; texto: string }[]>> = {
  'sim-nao': [
    { id: 'sim', texto: 'Sim' },
    { id: 'nao', texto: 'Não' },
  ],
  atendimento: [
    { id: 'presencial', texto: 'Presencial' },
    { id: 'online', texto: 'Online' },
  ],
}

/**
 * Tipos que só fazem sentido UMA vez, porque cada um alimenta um campo
 * estruturado da mensagem final (o formato do atendimento e o nome de quem
 * escreve). Duas perguntas de nome deixariam a mensagem com dois "Nome:".
 */
export const TIPOS_UNICOS: TipoDePergunta[] = ['atendimento', 'contato']

/**
 * Destino que encerra a triagem: a conversa pula para o agendamento (ou para o
 * envio, quando não há grade). É o "não preciso saber mais nada" do advogado.
 */
export const FIM_DA_TRIAGEM = 'fim'

export interface OpcaoDeTriagem {
  id: string
  /** o texto que o visitante lê e toca */
  texto: string
  /**
   * Para onde ESTA resposta leva: o id de uma pergunta seguinte, ou
   * `FIM_DA_TRIAGEM`. Ausente = a próxima pergunta da lista, que é como toda
   * triagem começa e como a maioria vai continuar.
   *
   * Só aponta para FRENTE — ver a segunda passagem de `normalizarTriagem`.
   */
  proxima?: string
}

export interface PerguntaDeTriagem {
  id: string
  kind: TipoDePergunta
  /** a pergunta como o visitante a lê */
  label: string
  /** respostas possíveis — escritas pelo advogado, ou as fixas de OPCOES_FIXAS */
  options?: OpcaoDeTriagem[]
  /** o visitante pode seguir sem responder */
  optional?: boolean
  /**
   * Para onde a conversa vai DEPOIS desta pergunta, quando a resposta não
   * escolhe o caminho (pergunta escrita à mão, data, nome) ou quando a opção
   * respondida não tem destino próprio.
   */
  proxima?: string
}

export interface TriagemConfig {
  enabled: boolean
  questions: PerguntaDeTriagem[]
}

// ---- Tetos ------------------------------------------------------------------
//
// Curtos de propósito. Uma triagem de vinte perguntas não é triagem, é
// formulário — e formulário longo no celular é abandonado no meio. O limite
// também é a proteção mais barata contra coleta excessiva: quem tem oito
// perguntas escolhe as oito que importam.
//
// Com ramificação o teto conta ainda mais a favor: oito perguntas com caminhos
// diferentes cobrem muito mais casos do que oito perguntas em fila.

/** Perguntas por perfil. */
export const TRIAGEM_MAX_PERGUNTAS = 8
/** Tamanho do enunciado. */
export const TRIAGEM_LABEL_MAX = 120
/** Opções por pergunta de escolha. */
export const TRIAGEM_MAX_OPCOES = 8
/** Tamanho de cada opção. */
export const TRIAGEM_OPCAO_MAX = 40
/** Resposta curta do visitante (também vale para 'contato'). */
export const TRIAGEM_RESPOSTA_MAX = 140
/** Resposta longa do visitante ("conte brevemente"). */
export const TRIAGEM_RESPOSTA_LONGA_MAX = 400

/** Id utilizável: curto, previsível e seguro de pôr numa chave de React. */
const ID_OK = /^[A-Za-z0-9_-]{1,40}$/

const texto = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''

/** Opções ESCRITAS pelo advogado, já limpas, sem repetição e com id estável. */
function opcoesEscritas(raw: unknown): OpcaoDeTriagem[] {
  const out: OpcaoDeTriagem[] = []
  const idsUsados = new Set<string>()
  for (const o of Array.isArray(raw) ? raw : []) {
    if (out.length === TRIAGEM_MAX_OPCOES) break
    // Compat com a forma antiga (lista de strings): a triagem nasceu assim, e
    // um perfil gravado naquele formato não pode perder as opções ao ser lido.
    const bruta: Partial<OpcaoDeTriagem> =
      typeof o === 'string' ? { texto: o } : ((o ?? {}) as OpcaoDeTriagem)
    const valor = texto(bruta.texto, TRIAGEM_OPCAO_MAX)
    if (!valor || out.some((x) => x.texto === valor)) continue
    const idBruto = String(bruta.id ?? '')
    // Id próprio, e não o texto como chave: o advogado renomeia uma opção o
    // tempo todo, e com chave de texto o caminho que sai dela se perderia
    // silenciosamente a cada correção de digitação.
    const id = ID_OK.test(idBruto) && !idsUsados.has(idBruto) ? idBruto : `o${out.length + 1}`
    idsUsados.add(id)
    const opcao: OpcaoDeTriagem = { id, texto: valor }
    const destino = String(bruta.proxima ?? '')
    if (destino) opcao.proxima = destino
    out.push(opcao)
  }
  return out
}

/** As opções fixas de um tipo, preservando o caminho que cada uma já levava. */
function opcoesFixas(kind: TipoDePergunta, raw: unknown): OpcaoDeTriagem[] {
  const anteriores = new Map(
    (Array.isArray(raw) ? raw : [])
      .filter((o): o is OpcaoDeTriagem => !!o && typeof o === 'object')
      .map((o) => [String(o.id ?? ''), String(o.proxima ?? '')]),
  )
  return (OPCOES_FIXAS[kind] ?? []).map((o) => {
    const destino = anteriores.get(o.id)
    return destino ? { ...o, proxima: destino } : { ...o }
  })
}

/**
 * A config utilizável a partir de qualquer coisa que tenha chegado.
 *
 * Nunca lança: corpo malformado vira triagem vazia e desligada, e o perfil
 * continua exatamente como estava. É a mesma postura de `resolveAssistantConfig`
 * — a conversa do visitante não pode depender de um JSON bem-formado.
 *
 * O que é DESCARTADO (e por quê):
 *   • o que não é sequer um objeto;
 *   • tipo desconhecido — vira 'texto', que é o tipo que responde qualquer coisa;
 *   • a segunda pergunta de nome ou de formato de atendimento (ver TIPOS_UNICOS);
 *   • opção repetida ou vazia;
 *   • caminho que aponta para trás, para a própria pergunta ou para o nada —
 *     ver a segunda passagem, que é o que garante que a conversa termina.
 *
 * O que é MANTIDO mesmo estando pela metade: pergunta ainda sem enunciado e
 * pergunta de escolha ainda sem opções. Nenhuma das duas vai à conversa (ver
 * `perguntasUtilizaveis`), mas as duas continuam no editor — apagar em silêncio
 * o que alguém está escrevendo é pior do que guardar um rascunho.
 */
export function normalizarTriagem(raw: unknown): TriagemConfig {
  const bruto = (raw ?? {}) as Partial<TriagemConfig>
  const lista = Array.isArray(bruto.questions) ? bruto.questions : []
  const questions: PerguntaDeTriagem[] = []
  const idsUsados = new Set<string>()
  const unicosUsados = new Set<TipoDePergunta>()

  for (const q of lista) {
    if (questions.length === TRIAGEM_MAX_PERGUNTAS) break
    if (!q || typeof q !== 'object') continue
    // Enunciado em branco é MANTIDO: é a pergunta que o advogado acabou de
    // adicionar e ainda não escreveu. Descartá-la aqui fazia o botão "+
    // Adicionar pergunta" não adicionar nada — o item nascia e morria no mesmo
    // salvamento. Ela não chega à conversa (ver perguntasUtilizaveis).
    const bruta = q as PerguntaDeTriagem
    const label = texto(bruta.label, TRIAGEM_LABEL_MAX)

    const kind: TipoDePergunta = TIPOS_DE_PERGUNTA.includes(bruta.kind) ? bruta.kind : 'texto'
    if (TIPOS_UNICOS.includes(kind)) {
      if (unicosUsados.has(kind)) continue
      unicosUsados.add(kind)
    }

    // Id do corpo quando serve; senão um nosso. A posição entra no id gerado só
    // para ele não colidir com o da pergunta seguinte.
    const idBruto = String(bruta.id ?? '')
    const id = ID_OK.test(idBruto) && !idsUsados.has(idBruto) ? idBruto : `t${questions.length + 1}`
    idsUsados.add(id)

    const pergunta: PerguntaDeTriagem = { id, kind, label }
    if (TIPOS_COM_OPCOES.includes(kind)) pergunta.options = opcoesEscritas(bruta.options)
    else if (OPCOES_FIXAS[kind]) pergunta.options = opcoesFixas(kind, bruta.options)
    if (bruta.optional === true) pergunta.optional = true
    const destino = String(bruta.proxima ?? '')
    if (destino) pergunta.proxima = destino
    questions.push(pergunta)
  }

  // ---- Segunda passagem: os caminhos -----------------------------------------
  //
  // Um destino só vale se aponta para uma pergunta que vem DEPOIS, ou para o fim
  // da triagem. É essa regra — e não um detector de ciclos — que garante que a
  // conversa termina: sem ela, "pergunta 2 → pergunta 1" deixaria o visitante
  // rodando em círculo, e quem descobriria seria ele.
  //
  // Caminho inválido some em silêncio, e é de propósito: ele aparece quando o
  // advogado MOVE uma pergunta para cima, e o roteiro desenhado no editor mostra
  // na hora o caminho novo. Segurar um destino quebrado seria pior.
  const indicePorId = new Map(questions.map((q, i) => [q.id, i]))
  const valido = (destino: string | undefined, i: number): string | undefined => {
    if (!destino) return undefined
    if (destino === FIM_DA_TRIAGEM) return FIM_DA_TRIAGEM
    const alvo = indicePorId.get(destino)
    return alvo !== undefined && alvo > i ? destino : undefined
  }
  questions.forEach((q, i) => {
    const daPergunta = valido(q.proxima, i)
    if (daPergunta) q.proxima = daPergunta
    else delete q.proxima
    for (const o of q.options ?? []) {
      // Múltipla escolha não ramifica: o visitante marca várias, e duas respostas
      // apontando para lugares diferentes não têm desempate honesto. O caminho
      // dela é sempre o da pergunta.
      const daOpcao = q.kind === 'multipla' ? undefined : valido(o.proxima, i)
      if (daOpcao) o.proxima = daOpcao
      else delete o.proxima
    }
  })

  return { enabled: bruto.enabled === true, questions }
}

/**
 * As perguntas que a CONVERSA pode de fato fazer.
 *
 * Uma pergunta de escolha sem nenhuma opção não tem como ser respondida: mostrá-la
 * deixaria o visitante parado numa tela sem saída. Ela fica guardada no editor,
 * onde o advogado termina de escrevê-la, e simplesmente não entra em cena.
 */
export function perguntasUtilizaveis(questions: PerguntaDeTriagem[]): PerguntaDeTriagem[] {
  return questions.filter(
    (q) => !!q.label.trim() && (!TIPOS_COM_OPCOES.includes(q.kind) || !!q.options?.length),
  )
}

/**
 * O índice da próxima pergunta, depois de `indice` ser respondido com `opcaoId`.
 *
 * A cascata é: o caminho da RESPOSTA, depois o caminho da PERGUNTA, depois a
 * próxima da lista. Devolver `perguntas.length` significa "acabou a triagem" —
 * daí em diante é o agendamento de sempre.
 *
 * `perguntas` aqui é a lista que a conversa percorre (`perguntasUtilizaveis`),
 * porque é nela que os índices fazem sentido. Um destino que não existe mais
 * nessa lista volta a ser "a próxima": o normalizador já derrubou os inválidos,
 * e esta é a segunda rede.
 */
export function proximaPergunta(
  perguntas: PerguntaDeTriagem[],
  indice: number,
  opcaoId?: string,
): number {
  const atual = perguntas[indice]
  if (!atual) return perguntas.length
  const daOpcao = opcaoId ? atual.options?.find((o) => o.id === opcaoId)?.proxima : undefined
  const destino = daOpcao ?? atual.proxima
  if (!destino) return indice + 1
  if (destino === FIM_DA_TRIAGEM) return perguntas.length
  const alvo = perguntas.findIndex((q) => q.id === destino)
  return alvo > indice ? alvo : indice + 1
}

/**
 * Os ids das perguntas que a conversa CONSEGUE alcançar, partindo da primeira.
 *
 * Existe por causa do defeito clássico de todo formulário com caminhos: uma
 * pergunta para a qual ninguém é mandado. Ela fica na tela do advogado, parece
 * que está no ar, e nunca é feita a ninguém. O editor avisa — não bloqueia: o
 * advogado pode estar no meio de montar o caminho.
 */
export function perguntasAlcancaveis(questions: PerguntaDeTriagem[]): Set<string> {
  const uteis = perguntasUtilizaveis(questions)
  const vistos = new Set<string>()
  const fila: number[] = uteis.length ? [0] : []
  while (fila.length) {
    const i = fila.shift() as number
    const q = uteis[i]
    if (!q || vistos.has(q.id)) continue
    vistos.add(q.id)
    const saidas = q.options?.length
      ? q.options.map((o) => proximaPergunta(uteis, i, o.id))
      : [proximaPergunta(uteis, i)]
    // Pergunta que dá para pular tem uma saída a mais: o caminho de quem não
    // respondeu, que é sempre o da própria pergunta.
    if (q.optional) saidas.push(proximaPergunta(uteis, i))
    for (const j of saidas) if (j < uteis.length) fila.push(j)
  }
  return vistos
}

/**
 * Os enunciados e as opções, em texto corrido — é o que passa pela checagem de
 * conformidade (ver oab/compliance.ts). Tudo aqui é lido pelo visitante, então
 * tudo aqui é publicidade advocatícia como qualquer linha do perfil.
 */
export function textosDaTriagem(config: TriagemConfig | null | undefined): string[] {
  const out: string[] = []
  for (const q of config?.questions ?? []) {
    if (q.label?.trim()) out.push(q.label)
    // Só as opções ESCRITAS pelo advogado. "Sim", "Não", "Presencial" e "Online"
    // são nossas — conferi-las seria a plataforma auditando o próprio vocabulário.
    if (!TIPOS_COM_OPCOES.includes(q.kind)) continue
    for (const o of q.options ?? []) if (o.texto?.trim()) out.push(o.texto)
  }
  return out
}

/**
 * A triagem está de pé? Enunciados existem, alguém pode respondê-los e o
 * advogado ligou o interruptor.
 *
 * A trava de PLANO não mora aqui de propósito: quem decide isso é
 * `canUseTriagem` (plans.ts), no único lugar em que o plano vigente é conhecido.
 */
export function triagemAtiva(config: TriagemConfig | null | undefined): boolean {
  return !!config?.enabled && perguntasUtilizaveis(config.questions ?? []).length > 0
}
