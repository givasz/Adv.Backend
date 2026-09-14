// O QUE UMA PERGUNTA DE TRIAGEM ESTÁ PEDINDO.
//
// ⚠️ MANTER EM SINCRONIA com frontend/src/lib/triagemDados.ts. Os casos moram no
// front (frontend/src/lib/triagem.casos.json) e os DOIS lados passam por eles.
//
// A DIFERENÇA PARA contratos/dado-pessoal.ts
//
// Aquele acha dado pessoal ESCRITO num texto ("CPF 529.982.247-25"). Este acha
// pergunta que PEDE dado pessoal ("Qual o seu CPF?"). São problemas opostos: lá o
// dado já está lá; aqui ele ainda não existe, e o que se quer é que ele nunca
// passe a existir. Por isso aqui não há regex de valor — há vocabulário de pedido.
//
// DUAS ALTURAS, E O PORQUÊ DE NÃO SEREM UMA SÓ
//
// • BLOQUEIO — senha, código de confirmação, cartão e conta bancária. Não existe
//   triagem inicial legítima que precise disso, e uma tela de advogado pedindo
//   "o código que chegou no seu SMS" é um golpe pronto, quer o advogado saiba ou
//   não. O servidor recusa, e é o único caso em que recusa.
//
// • AVISO — CPF, RG, documento para anexar, saúde, endereço completo, número de
//   processo, dado de terceiro, renda. Cada um deles TEM uso legítimo em algum
//   escritório: o previdenciarista precisa saber da perícia, o trabalhista
//   precisa do holerite em algum momento. O que a triagem inicial não precisa é
//   disso AGORA — e é isso que o aviso diz, com uma reescrita pronta ao lado.
//
// O QUE ESTE ARQUIVO NÃO FAZ, DE PROPÓSITO
//
// Não bloqueia a palavra "processo" nem a palavra "documento" sozinhas: "Você já
// tem processo sobre isso?" é a pergunta de triagem mais comum que existe, e
// barrá-la seria a plataforma discutindo redação com advogado. Só "número do
// processo" e "envie o documento" viram apontamento.
//
// E ele não é garantia de nada: é um guarda-corpo. Quem responde pelo conteúdo e
// pelo tratamento dos dados é o profissional — está escrito na tela, ao lado.

export type RiscoDaPergunta = 'bloqueio' | 'aviso'

export type TipoDePedido =
  | 'credencial' // senha, código de confirmação, login
  | 'cartao' // número do cartão, CVV
  | 'bancario' // conta, agência, chave Pix
  | 'documento' // CPF, RG, CNH, certidão — e pedido de anexo
  | 'saude' // laudo, exame, diagnóstico, remédio
  | 'sensivel' // religião, orientação sexual, raça, biometria (LGPD art. 5º, II)
  | 'financeiro' // salário, extrato, imposto de renda
  | 'terceiro' // dado de quem não está na conversa
  | 'endereco' // endereço residencial completo
  | 'processo' // número do processo

export interface AchadoNaPergunta {
  risco: RiscoDaPergunta
  tipo: TipoDePedido
  /** o trecho da pergunta que disparou o apontamento */
  trecho: string
  /** o problema, em uma frase que o advogado lê no editor */
  motivo: string
  /** uma pergunta que serve à triagem sem pedir o dado — vira botão de um toque */
  sugestao: string
}

interface Regra {
  tipo: TipoDePedido
  risco: RiscoDaPergunta
  test: RegExp
  motivo: string
  sugestao: string
}

// `(?:^|[^\p{L}])` / `(?![\p{L}])` com a flag `u`, e nunca `\b`: a fronteira de
// palavra do JavaScript é ASCII, e com ela "rg" casaria dentro de "órgão" — o
// mesmo defeito que já desligou uma vedação em silêncio no motor da OAB
// (ver oab.rules.ts e oabAcentos.spec.ts). Lookbehind NÃO serve: o Safari/iOS só
// o entende a partir do 16.4, e nos iPhones anteriores a regex derrubava a
// página. O prefixo consome o separador, e `semSeparador` o tira do trecho.
const L = '(?:^|[^\\p{L}])'
const R = '(?![\\p{L}])'
const re = (fonte: string) => new RegExp(`${L}(?:${fonte})${R}`, 'iu')
/** O trecho sem o espaço ou a pontuação que o prefixo `L` casou antes da palavra. */
const semSeparador = (casado: string) => casado.replace(/^[^\p{L}\p{N}](?=\p{L})/u, '')

const REGRAS: Regra[] = [
  // ---- Bloqueio -------------------------------------------------------------
  {
    tipo: 'credencial',
    risco: 'bloqueio',
    test: re(
      'senhas?|c[óo]digo de (confirma[çc][ãa]o|verifica[çc][ãa]o|seguran[çc]a|acesso)|c[óo]digo do (sms|whatsapp|aplicativo)|token de acesso|seus? (dados de )?login|usu[áa]rio e senha|acesso ao (seu )?gov\\.?br',
    ),
    motivo:
      'Nenhuma triagem precisa de senha ou de código de confirmação — e um pedido desses numa página de advogado é o que um golpe faria.',
    sugestao: 'Qual assunto você deseja tratar?',
  },
  {
    tipo: 'cartao',
    risco: 'bloqueio',
    test: re(
      'n[úu]mero do cart[ãa]o|cart[ãa]o de (cr[ée]dito|d[ée]bito)|cvv|c[óo]digo de seguran[çc]a do cart[ãa]o|validade do cart[ãa]o',
    ),
    motivo: 'Dados de cartão não têm função nenhuma numa triagem, e o advoc.me não recebe pagamento por aqui.',
    sugestao: 'Como prefere o atendimento: online ou presencial?',
  },
  {
    tipo: 'bancario',
    risco: 'bloqueio',
    test: re(
      'dados banc[áa]rios|conta (banc[áa]ria|corrente|poupan[çc]a)|n[úu]mero da conta|ag[êe]ncia banc[áa]ria|chave pix',
    ),
    motivo: 'Conta e chave Pix não servem à triagem inicial — e, pedidos aqui, abrem uma porta de fraude no seu nome.',
    sugestao: 'Conte brevemente o que aconteceu.',
  },

  // ---- Aviso ----------------------------------------------------------------
  {
    tipo: 'documento',
    risco: 'aviso',
    test: re(
      'cpf|rgs?|carteira de (identidade|trabalho|motorista)|cnh|passaporte|t[íi]tulo de eleitor|pis|pasep|ctps|certid[ãa]o de (nascimento|casamento|[óo]bito)',
    ),
    motivo:
      'Documento de identificação não é preciso para decidir se você vai atender alguém — e guardá-lo antes da hora é coleta além do necessário (LGPD, art. 6º, III).',
    sugestao: 'Como posso te chamar?',
  },
  {
    tipo: 'documento',
    risco: 'aviso',
    test: new RegExp(
      `${L}(?:envie|enviar|mande|mandar|anexe|anexar|encaminhe|encaminhar|fa[çc]a upload|foto|c[óo]pia|print|digitalizad\\w+)${R}[\\s\\S]{0,29}${L}(?:documentos?|comprovantes?|contratos?|certid[ãa]o|carteira|laudos?|holerite|extratos?|processo)${R}`,
      'iu',
    ),
    motivo:
      'Anexo no primeiro contato é o que mais cria risco: o arquivo passa por aplicativos de terceiros e fica no aparelho de quem enviou. Peça depois, quando souber que vai atender.',
    sugestao: 'Conte brevemente o que aconteceu.',
  },
  {
    tipo: 'saude',
    risco: 'aviso',
    test: re(
      'laudos?|prontu[áa]rio|exames?|diagn[óo]sticos?|cid[- ]?10|doen[çc]as?|medicamentos?|rem[ée]dios?|tratamento m[ée]dico|atestado m[ée]dico|problema de sa[úu]de',
    ),
    motivo:
      'Informação de saúde é dado sensível (LGPD, art. 5º, II) e exige cuidado próprio. Na triagem, o assunto em linhas gerais basta.',
    sugestao: 'Qual assunto você deseja tratar?',
  },
  {
    tipo: 'sensivel',
    risco: 'aviso',
    test: re(
      'religi[ãa]o|cren[çc]a religiosa|orienta[çc][ãa]o sexual|vida sexual|ra[çc]a|etnia|cor da pele|partido pol[íi]tico|filia[çc][ãa]o (partid[áa]ria|sindical)|sindicato|biometria|digital do dedo|reconhecimento facial',
    ),
    motivo:
      'Isto é dado pessoal sensível (LGPD, art. 5º, II): só pode ser tratado em hipótese específica, e uma triagem inicial não é uma delas.',
    sugestao: 'Qual assunto você deseja tratar?',
  },
  {
    tipo: 'financeiro',
    risco: 'aviso',
    test: re(
      'sal[áa]rio|renda mensal|quanto (voc[êe] )?(ganha|recebe)|holerite|contracheque|extrato banc[áa]rio|imposto de renda|declara[çc][ãa]o de bens|patrim[ôo]nio',
    ),
    motivo:
      'Valor de renda é detalhe do caso, não da triagem — e é justamente o tipo de informação que não se quer guardada num histórico de conversa.',
    sugestao: 'Conte brevemente o que aconteceu.',
  },
  {
    tipo: 'terceiro',
    risco: 'aviso',
    test: new RegExp(
      `${L}(?:dados?|nome|cpf|rg|telefone|endere[çc]o|contato)${R}[\\s\\S]{0,20}${L}(?:d[ao]s? (?:outra parte|parte contr[áa]ria|r[ée]u|reclamad[oa]|ex[- ]?(?:marido|mulher|esposa|c[ôo]njuge)|c[ôo]njuge|patr[ãa]o|chefe|terceiros?|filh[oa]s?))${R}`,
      'iu',
    ),
    motivo:
      'Dado de quem não está na conversa é tratado sem que a pessoa saiba. Na triagem, quem escreve fala por si.',
    sugestao: 'Conte brevemente o que aconteceu.',
  },
  {
    tipo: 'endereco',
    risco: 'aviso',
    test: re(
      'endere[çc]o (completo|residencial|da sua casa)|onde (voc[êe] )?mora|rua e n[úu]mero|seu cep',
    ),
    motivo:
      'O endereço completo só faz falta quando o atendimento já existe. Para a triagem, a cidade resolve.',
    sugestao: 'Em qual cidade você está?',
  },
  {
    tipo: 'processo',
    risco: 'aviso',
    test: re('n[úu]mero d[oe] processo|n[ºo°]\\.? ?d[oe] processo|numera[çc][ãa]o do processo'),
    motivo:
      'O número do processo abre os autos e tudo o que há neles. Se você precisa mesmo dele aqui, mantenha — mas na maioria das triagens saber que EXISTE processo já basta.',
    sugestao: 'Você já possui processo relacionado a esse assunto?',
  },
]

/**
 * Tudo que a pergunta está pedindo e não deveria, na ordem das regras.
 *
 * Um tipo aparece UMA vez: "Qual seu CPF e seu RG?" é um problema só, e dois
 * apontamentos idênticos na tela só fazem o advogado parar de ler os avisos.
 */
export function conferirPergunta(texto: string): AchadoNaPergunta[] {
  const alvo = String(texto ?? '')
  if (!alvo.trim()) return []
  const out: AchadoNaPergunta[] = []
  const vistos = new Set<TipoDePedido>()
  for (const regra of REGRAS) {
    if (vistos.has(regra.tipo)) continue
    const m = regra.test.exec(alvo)
    if (!m) continue
    vistos.add(regra.tipo)
    out.push({
      risco: regra.risco,
      tipo: regra.tipo,
      trecho: semSeparador(m[0]).trim(),
      motivo: regra.motivo,
      sugestao: regra.sugestao,
    })
  }
  return out
}


/**
 * A pergunta INTEIRA — enunciado e opções de resposta.
 *
 * O enunciado sozinho deixava uma porta aberta: "Qual informação você quer
 * enviar?" com a opção "Minha senha do banco" passava pelos dois portões. O
 * visitante lê as opções tanto quanto lê a pergunta, e é nelas que ele toca.
 */
export function conferirPerguntaInteira(pergunta: {
  label?: string | null
  options?: ({ texto?: string | null } | null)[] | null
}): AchadoNaPergunta[] {
  const out: AchadoNaPergunta[] = []
  const vistos = new Set<TipoDePedido>()
  const textos = [pergunta?.label ?? '', ...(pergunta?.options ?? []).map((o) => o?.texto ?? '')]
  for (const texto of textos) {
    for (const achado of conferirPergunta(String(texto ?? ''))) {
      if (vistos.has(achado.tipo)) continue
      vistos.add(achado.tipo)
      out.push(achado)
    }
  }
  return out
}

/**
 * A pergunta pede algo que o servidor recusa gravar? (só credencial/cartão/conta)
 * Confere enunciado E opções — ver conferirPerguntaInteira.
 */
export function perguntaBloqueada(pergunta: {
  label?: string | null
  options?: ({ texto?: string | null } | null)[] | null
}): AchadoNaPergunta | null {
  return conferirPerguntaInteira(pergunta).find((a) => a.risco === 'bloqueio') ?? null
}
