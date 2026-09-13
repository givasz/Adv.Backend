// O FORMATO DA TRIAGEM — fonte da verdade do que pode ser gravado.
//
// ⚠️ MANTER EM SINCRONIA com frontend/src/lib/triagem.ts. Os dois lados passam
// pelos mesmos casos (frontend/src/lib/triagem.casos.json) — se só um mudar, a
// tela aceita e o servidor recusa (ou o contrário, que é pior: a tela promete uma
// pergunta que a conversa nunca vai fazer).
//
// O QUE ESTE ARQUIVO GUARDA, E O QUE ELE NÃO GUARDA
//
// Guarda as PERGUNTAS que o advogado escreveu. Não guarda, e não deve passar a
// guardar, nenhuma RESPOSTA de visitante: o que a pessoa responde é montado no
// aparelho dela e sai direto para o WhatsApp do advogado. Não existe coluna, não
// existe rota e não existe caminho pelo qual uma resposta chegue até aqui — é a
// mesma decisão que tirou a agenda-calendário do produto em 21/08/2026.
//
// Conformidade (Prov. 205/2021 + Cartilha do CFOAB): o chatbot é admitido para
// facilitar a comunicação, encaminhar primeiras informações e coletar dados — e
// é vedado usá-lo para RESPONDER consulta jurídica. Por isso a triagem só tem
// perguntas: não há campo de "resposta automática", não há classificação do caso
// e não há IA em lugar nenhum deste caminho.

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

/** Tipos que dependem de uma lista escrita pelo advogado. */
export const TIPOS_COM_OPCOES: TipoDePergunta[] = ['escolha', 'multipla']

/**
 * Tipos que só fazem sentido UMA vez, porque cada um alimenta um campo
 * estruturado da mensagem final (o formato do atendimento e o nome de quem
 * escreve). Duas perguntas de nome deixariam a mensagem com dois "Nome:".
 */
export const TIPOS_UNICOS: TipoDePergunta[] = ['atendimento', 'contato']

export interface PerguntaDeTriagem {
  id: string
  kind: TipoDePergunta
  /** a pergunta como o visitante a lê */
  label: string
  /** opções de resposta — só em 'escolha' e 'multipla' */
  options?: string[]
  /** o visitante pode seguir sem responder */
  optional?: boolean
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
 *   • opção repetida ou vazia.
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
    const label = texto((q as PerguntaDeTriagem)?.label, TRIAGEM_LABEL_MAX)

    const pedido = (q as PerguntaDeTriagem)?.kind
    const kind: TipoDePergunta = TIPOS_DE_PERGUNTA.includes(pedido) ? pedido : 'texto'
    if (TIPOS_UNICOS.includes(kind)) {
      if (unicosUsados.has(kind)) continue
      unicosUsados.add(kind)
    }

    // Id do corpo quando serve; senão um nosso. A posição entra no id gerado só
    // para ele não colidir com o da pergunta seguinte.
    const idBruto = String((q as PerguntaDeTriagem)?.id ?? '')
    const id =
      ID_OK.test(idBruto) && !idsUsados.has(idBruto) ? idBruto : `t${questions.length + 1}`
    idsUsados.add(id)

    const pergunta: PerguntaDeTriagem = { id, kind, label }
    if (TIPOS_COM_OPCOES.includes(kind)) {
      const opcoes: string[] = []
      for (const o of Array.isArray((q as PerguntaDeTriagem)?.options) ? q.options! : []) {
        const valor = texto(o, TRIAGEM_OPCAO_MAX)
        if (!valor || opcoes.includes(valor)) continue
        opcoes.push(valor)
        if (opcoes.length === TRIAGEM_MAX_OPCOES) break
      }
      pergunta.options = opcoes
    }
    if ((q as PerguntaDeTriagem)?.optional === true) pergunta.optional = true
    questions.push(pergunta)
  }

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
 * A triagem está de pé? Enunciados existem, alguém pode respondê-los e o
 * advogado ligou o interruptor.
 *
 * A trava de PLANO não mora aqui de propósito: quem decide isso é
 * `canUseTriagem` (plans.ts), no único lugar em que o plano vigente é conhecido.
 */
export function triagemAtiva(config: TriagemConfig | null | undefined): boolean {
  return !!config?.enabled && perguntasUtilizaveis(config.questions ?? []).length > 0
}

/**
 * Os enunciados e as opções, em texto corrido — é o que passa pela checagem de
 * conformidade (ver oab/compliance.ts). Tudo aqui é lido pelo visitante, então
 * tudo aqui é publicidade advocatícia como qualquer outra linha do perfil.
 */
export function textosDaTriagem(config: TriagemConfig | null | undefined): string[] {
  const out: string[] = []
  for (const q of config?.questions ?? []) {
    if (q.label?.trim()) out.push(q.label)
    for (const o of q.options ?? []) if (o.trim()) out.push(o)
  }
  return out
}
