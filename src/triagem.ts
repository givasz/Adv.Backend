// O FORMATO DA TRIAGEM — fonte da verdade do que pode ser gravado.
//
// ⚠️ MANTER EM SINCRONIA com frontend/src/lib/triagem.ts. Os dois lados passam
// pelos mesmos casos (frontend/src/lib/triagem.casos.json) — se só um mudar, a
// tela aceita e o servidor recusa (ou o contrário, que é pior: a tela promete uma
// pergunta que a conversa nunca vai fazer).
//
// O QUE ESTE ARQUIVO GUARDA, E O QUE ELE NÃO GUARDA
//
// Guarda as PERGUNTAS que o advogado escreveu, e as LIGAÇÕES entre elas (qual
// resposta abre qual pergunta). Não guarda, e não deve passar a guardar, nenhuma
// RESPOSTA de visitante: o que a pessoa responde é montado no aparelho dela e
// sai direto para o WhatsApp do advogado. Não existe coluna, não existe rota e
// não existe caminho pelo qual uma resposta chegue até aqui — é a mesma decisão
// que tirou a agenda-calendário do produto em 21/08/2026.
//
// Conformidade (Prov. 205/2021 + Cartilha do CFOAB): o chatbot é admitido para
// facilitar a comunicação, encaminhar primeiras informações e coletar dados — e
// é vedado usá-lo para RESPONDER consulta jurídica. Por isso a triagem só tem
// perguntas: não há campo de "resposta automática", não há classificação do caso
// e não há IA em lugar nenhum deste caminho. Ramificar não muda isso: quem
// decide qual resposta abre qual pergunta é o advogado, escrevendo, e o
// assistente apenas anda pelo desenho que ele fez.

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
 * para que ligar uma resposta a uma pergunta seja um mecanismo só. "Sim" pode
 * abrir uma pergunta e "Não" outra, exatamente como numa escolha escrita à mão.
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

export interface OpcaoDeTriagem {
  id: string
  /** o texto que o visitante lê e toca */
  texto: string
  /**
   * Quem dá esta resposta encerra a triagem ali: a conversa pula para o
   * agendamento (ou para o envio, quando não há grade). Múltipla escolha não
   * encerra — ver o normalizador.
   */
  encerra?: true
}

/**
 * "Esta pergunta só é feita a quem respondeu ASSIM numa pergunta anterior."
 * Sem condição, a pergunta é feita a todo mundo que chegar até ela.
 */
export interface CondicaoDaPergunta {
  /** o id de uma pergunta ANTERIOR, que tenha opções */
  pergunta: string
  /** as respostas dela que abrem esta pergunta — basta uma */
  opcoes: string[]
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
  /** só é feita a quem deu uma destas respostas — ausente = feita a todos */
  condicao?: CondicaoDaPergunta
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
    // tempo todo, e com chave de texto a pergunta ligada a ela se soltaria
    // silenciosamente a cada correção de digitação.
    const id = ID_OK.test(idBruto) && !idsUsados.has(idBruto) ? idBruto : `o${out.length + 1}`
    idsUsados.add(id)
    const opcao: OpcaoDeTriagem = { id, texto: valor }
    if (bruta.encerra === true) opcao.encerra = true
    out.push(opcao)
  }
  return out
}

/** As opções fixas de um tipo, preservando as que já encerravam a triagem. */
function opcoesFixas(kind: TipoDePergunta, raw: unknown): OpcaoDeTriagem[] {
  const encerravam = new Set(
    (Array.isArray(raw) ? raw : [])
      .filter((o): o is OpcaoDeTriagem => !!o && typeof o === 'object' && o.encerra === true)
      .map((o) => String(o.id ?? '')),
  )
  return (OPCOES_FIXAS[kind] ?? []).map((o) =>
    encerravam.has(o.id) ? { ...o, encerra: true as const } : { ...o },
  )
}

/** A condição como veio, só com a FORMA conferida — o sentido é da 2ª passagem. */
function condicaoBruta(raw: unknown): CondicaoDaPergunta | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const c = raw as Partial<CondicaoDaPergunta>
  const pergunta = String(c.pergunta ?? '')
  if (!ID_OK.test(pergunta)) return undefined
  const opcoes = [
    ...new Set((Array.isArray(c.opcoes) ? c.opcoes : []).map(String).filter((id) => ID_OK.test(id))),
  ].slice(0, TRIAGEM_MAX_OPCOES)
  return { pergunta, opcoes }
}

/**
 * A config utilizável a partir de qualquer coisa que tenha chegado.
 *
 * Nunca lança: corpo malformado vira triagem vazia e desligada, e o perfil
 * continua exatamente como estava.
 *
 * O que é DESCARTADO (e por quê):
 *   • o que não é sequer um objeto;
 *   • tipo desconhecido — vira 'texto', que é o tipo que responde qualquer coisa;
 *   • a segunda pergunta de nome ou de formato de atendimento (ver TIPOS_UNICOS);
 *   • opção repetida ou vazia;
 *   • condição que depende de pergunta POSTERIOR, da própria pergunta, do nada,
 *     de pergunta sem opções ou de resposta que não existe — ver a segunda
 *     passagem, que é o que garante que a conversa termina.
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
    // adicionar e ainda não escreveu. Ela não chega à conversa.
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
    const condicao = condicaoBruta(bruta.condicao)
    if (condicao) pergunta.condicao = condicao
    questions.push(pergunta)
  }

  // ---- Segunda passagem: as ligações -----------------------------------------
  //
  // Uma condição só vale se depende de uma pergunta que vem ANTES. É essa regra
  // — e não um detector de ciclos — que garante que a conversa termina: a
  // conversa só anda para frente, e uma pergunta nunca espera por uma resposta
  // que ainda não foi dada.
  //
  // Ligação inválida some em silêncio: ela aparece quando o advogado apaga a
  // pergunta de que outra dependia, ou troca o tipo dela, e o fluxograma do
  // editor mostra na hora o desenho novo.
  limparLigacoes(questions, false)

  return { enabled: bruto.enabled === true, questions }
}

/**
 * As ligações que fazem sentido, aplicadas NO LUGAR. O editor usa a mesma regra
 * segurando a condição ainda sem resposta escolhida (`manterVazia`); aqui, que é
 * o que vai para a conversa, ela cai.
 */
function limparLigacoes(questions: PerguntaDeTriagem[], manterVazia: boolean) {
  const indicePorId = new Map(questions.map((q, i) => [q.id, i]))
  questions.forEach((q, i) => {
    for (const o of q.options ?? []) {
      // Múltipla escolha não encerra: quem marca "encerra" junto com outra
      // resposta que abre uma pergunta não tem desempate honesto.
      if (q.kind === 'multipla' || o.encerra !== true) delete o.encerra
    }
    if (!q.condicao) return
    const fonte = indicePorId.get(q.condicao.pergunta)
    const origem = fonte !== undefined && fonte < i ? questions[fonte] : undefined
    const ids = new Set((origem?.options ?? []).map((o) => o.id))
    const opcoes = q.condicao.opcoes.filter((id) => ids.has(id))
    if (!origem || !ids.size || (!opcoes.length && !manterVazia)) delete q.condicao
    else q.condicao = { pergunta: origem.id, opcoes }
  })
}

/**
 * As perguntas que a CONVERSA pode de fato fazer: com enunciado, com opção
 * quando é de escolha, e — quando dependem de outra — com a outra também em cena.
 */
export function perguntasUtilizaveis(questions: PerguntaDeTriagem[]): PerguntaDeTriagem[] {
  const ficaram = new Set<string>()
  return questions.filter((q) => {
    const pronta =
      !!q.label.trim() &&
      (!TIPOS_COM_OPCOES.includes(q.kind) || !!q.options?.length) &&
      (!q.condicao || ficaram.has(q.condicao.pergunta))
    if (pronta) ficaram.add(q.id)
    return pronta
  })
}

/**
 * O que o visitante já respondeu, do jeito que o CAMINHO precisa: o id da
 * pergunta e os ids das respostas tocadas. Pergunta pulada não entra.
 */
export type RespostasDoCaminho = Record<string, string[]>

/** Esta pergunta deve ser feita, dado o que já foi respondido? */
export function condicaoAtendida(
  pergunta: PerguntaDeTriagem,
  respostas: RespostasDoCaminho,
): boolean {
  const c = pergunta.condicao
  if (!c) return true
  return (respostas[c.pergunta] ?? []).some((id) => c.opcoes.includes(id))
}

/**
 * O índice da próxima pergunta, depois de `indice` ter sido respondido.
 *
 * Resposta que ENCERRA termina a triagem; senão, é a primeira pergunta seguinte
 * cuja condição foi atendida. O índice só cresce, então a conversa termina em no
 * máximo N passos, para qualquer configuração. `indice` -1 dá a primeira.
 */
export function proximaPergunta(
  perguntas: PerguntaDeTriagem[],
  indice: number,
  respostas: RespostasDoCaminho = {},
): number {
  const atual = perguntas[indice]
  if (atual && atual.kind !== 'multipla') {
    const tocadas = respostas[atual.id] ?? []
    if (atual.options?.some((o) => o.encerra && tocadas.includes(o.id))) return perguntas.length
  }
  let j = Math.max(indice + 1, 0)
  while (j < perguntas.length && !condicaoAtendida(perguntas[j], respostas)) j++
  return Math.min(j, perguntas.length)
}

/**
 * Os ids das perguntas que a conversa CONSEGUE alcançar, por algum caminho —
 * a pergunta que ninguém consegue receber é o defeito clássico de todo
 * formulário com caminhos. Guarda os estados vistos e tem teto: estourado,
 * devolve todas (não avisar é melhor do que avisar errado).
 */
export function perguntasAlcancaveis(questions: PerguntaDeTriagem[]): Set<string> {
  const uteis = perguntasUtilizaveis(questions)
  const vistos = new Set<string>()
  const fontes = [...new Set(uteis.flatMap((q) => (q.condicao ? [q.condicao.pergunta] : [])))]
  const estados = new Set<string>()
  let orcamento = 20000

  const andar = (i: number, respostas: RespostasDoCaminho): void => {
    if (i >= uteis.length) return
    const estado = `${i}|${fontes.map((f) => respostas[f]?.join(',') ?? '-').join(';')}`
    if (estados.has(estado)) return
    estados.add(estado)
    if (--orcamento < 0) throw new Error('teto')
    const q = uteis[i]
    vistos.add(q.id)
    const saidas: RespostasDoCaminho[] = q.options?.length
      ? q.options.map((o) => ({ ...respostas, [q.id]: [o.id] }))
      : [{ ...respostas, [q.id]: [] }]
    if (q.optional) saidas.push(respostas)
    for (const r of saidas) andar(proximaPergunta(uteis, i, r), r)
  }

  try {
    andar(proximaPergunta(uteis, -1), {})
  } catch {
    return new Set(uteis.map((q) => q.id))
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
