// O QUE MEDIMOS NO PERFIL PÚBLICO — e o que deliberadamente não medimos.
//
// ---------------------------------------------------------------------------
// A REGRA: contamos ACONTECIMENTOS, nunca PESSOAS.
//
// Cada linha de `LinkEvent` guarda três coisas: qual perfil, que tipo de ação, e
// quando. Não guardamos IP, não guardamos identificador de navegador, não
// gravamos cookie no visitante e não há como ligar duas linhas à mesma pessoa.
//
// Isso não é excesso de zelo — é a mesma decisão que tirou a agenda nativa do ar
// em 21/08: o visitante do perfil não é nosso usuário, não concordou com nada
// nosso, e muitas vezes está procurando advogado por um motivo que ele não
// contaria a um terceiro. Uma tabela nossa dizendo "este aparelho olhou o perfil
// de um criminalista às 3h" é um risco que nenhum relatório de produto paga.
//
// Consequência prática: NÃO temos visitante único, não temos funil por pessoa e
// não temos "de onde veio" por indivíduo. O que temos — volume, distribuição por
// hora, e qual botão foi usado — responde às perguntas que o advogado realmente
// faz ("estou sendo procurado?", "o que as pessoas clicam?") sem nada disso.
// ---------------------------------------------------------------------------

/**
 * Os tipos de acontecimento que aceitamos gravar.
 *
 * Lista FECHADA, e conferida na porta de entrada. `kind` é uma coluna de texto
 * livre no banco; sem esta lista, um laço de terminal encheria a tabela com
 * qualquer string — e como a rota é pública e sem sessão, seria a forma mais
 * barata de inflar o banco de outra pessoa.
 */
export const EVENTOS = [
  'view', // abriu a página do perfil
  'whatsapp', // tocou no botão de WhatsApp
  'agendamento', // tocou no botão de agendar (link externo)
  'assistente', // abriu a conversa guiada de agendamento
  'email', // tocou no e-mail
  'cartao', // salvou o contato (vCard) ou abriu o QR
  'endereco', // abriu o endereço do escritório no mapa
  'rede:instagram',
  'rede:linkedin',
  'rede:website',
  'rede:facebook',
  'rede:youtube',
  'rede:tiktok',
] as const

export type Evento = (typeof EVENTOS)[number]

/** Os eventos que representam alguém tentando FALAR com o advogado. */
export const EVENTOS_DE_CONTATO: Evento[] = [
  'whatsapp',
  'agendamento',
  'assistente',
  'email',
  'cartao',
  // Abrir o mapa é intenção de ir até o escritório — a forma mais forte de
  // procurar alguém, e a que mais depende de o endereço estar certo. Deixá-la
  // fora da conta faria o relatório dizer que ninguém procurou o advogado
  // justamente no dia em que três pessoas foram até a porta dele.
  'endereco',
]

export function ehEvento(valor: unknown): valor is Evento {
  return typeof valor === 'string' && (EVENTOS as readonly string[]).includes(valor)
}

/**
 * Por quanto tempo um acontecimento fica guardado.
 *
 * A LGPD pede prazo definido para tudo (art. 15, I) e a tabela cresce por
 * visita: sem teto, ela é o que mais cresce no banco inteiro. 400 dias cobre a
 * comparação "este mês contra o mesmo mês do ano passado", que é a pergunta mais
 * longa que alguém faz a um painel destes, com folga para o ano bissexto.
 *
 * O expurgo roda em `RetencaoService` (src/retencao).
 */
export const RETENCAO_EVENTOS_DIAS = 400

/** Janela padrão dos relatórios do painel do advogado. */
export const JANELA_PADRAO_DIAS = 30
