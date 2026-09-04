// UM ASSUNTO POR CAMPO — a trava que impede a cota de ser burlada por dentro.
//
// ⚠️ MANTER EM SINCRONIA com frontend/src/lib/campoUnico.ts.
//
// O PROBLEMA
//
// O Free entrega uma área de atuação e uma pergunta frequente. Um limite de
// contagem, sozinho, não resolve nada: quem quer três áreas escreve
// "Família, Sucessões e Inventários" no rótulo único, e quem quer três perguntas
// escreve "Quanto custa? Quanto demora? Preciso de advogado?" numa pergunta só.
// A cota fica intacta no banco e completamente furada na tela.
//
// E o resultado é pior para o próprio advogado: um tile de área com três assuntos
// empilhados não diz ao visitante o que aquele advogado faz — diz que ele faz
// tudo, que é a mesma coisa que não dizer nada. O perfil fica com cara de
// classificado, não de página profissional.
//
// O QUE ESTA TRAVA FAZ, E O QUE ELA NÃO FAZ
//
// Ela pega ENUMERAÇÃO EXPLÍCITA — vírgula, barra, ponto e vírgula, "+", "&", um
// travessão separando itens, dois pontos de interrogação. Coisas que só existem
// num campo porque a pessoa quis listar.
//
// Ela NÃO tenta adivinhar semântica. "Direito de Família e Sucessões" passa, e
// tem de passar: é o nome consagrado de UMA área, não duas coladas. Um "e" no
// meio de um nome de área é português normal, e barrá-lo seria a plataforma
// discutindo redação com advogado — perde-se a discussão e o cliente.
//
// Por isso o teto de caracteres (src/plans.ts) e esta trava trabalham juntos: um
// cuida do tamanho, a outra da forma. Nenhum dos dois pega tudo, e tudo bem: a
// intenção é tornar a burla trabalhosa e visível, não impossível.

/** Um campo que está carregando mais de um assunto. */
export interface ProblemaDeCampo {
  /** o que está errado, em uma frase que a pessoa lê no editor */
  motivo: string
  /**
   * O mesmo valor com só o PRIMEIRO item — vira o botão "ficar só com o
   * primeiro". Um aviso que bloqueia sem oferecer a correção é um aviso que faz
   * a pessoa desistir do campo, não corrigi-lo.
   */
  sugestao: string
}

// Separadores que só aparecem num rótulo porque alguém está listando.
//
// O travessão e o hífen exigem espaço dos dois lados: sem isso, "Cível-Criminal"
// e nomes com hífen legítimo cairiam junto.
const SEPARADOR_DE_LISTA = /\s*[,;/\\|•·]\s*|\s+[-–—+&]\s+/

/**
 * Os pedaços separados, já limpos e sem os vazios.
 *
 * Descartar os vazios é o que distingue uma lista de uma digitação pela metade:
 * "Direito Civil," tem um separador mas um item só, e reclamar dele seria
 * reclamar enquanto a pessoa ainda está escrevendo — o jeito mais rápido de
 * ensinar que os avisos deste editor podem ser ignorados.
 */
function itens(texto: string): string[] {
  return texto
    .split(SEPARADOR_DE_LISTA)
    .map((parte) => parte.trim().replace(/[\s,;/\\|•·+&-]+$/, '').trim())
    .filter(Boolean)
}

/**
 * O rótulo da área traz mais de uma área?
 *
 * Devolve `null` quando está tudo bem — é a forma que as duas pontas (editor e
 * servidor) usam para decidir se bloqueiam.
 */
export function areaComMaisDeUma(label: string): ProblemaDeCampo | null {
  const texto = (label ?? '').trim()
  if (!texto) return null

  const partes = itens(texto)
  if (partes.length < 2) return null

  return {
    motivo:
      'Parece haver mais de uma área neste campo. Cada área de atuação tem o campo dela — ' +
      'e um tile com três assuntos empilhados não diz a quem visita o que você faz.',
    sugestao: partes[0],
  }
}

/**
 * A pergunta traz mais de uma pergunta?
 *
 * O critério é o ponto de interrogação: dois deles são, literalmente, duas
 * perguntas. "Quanto custa e quanto demora?" tem um só e passa — não dá para
 * pegar sem adivinhar, e o teto de caracteres é quem segura esse caso.
 */
export function perguntaComMaisDeUma(question: string): ProblemaDeCampo | null {
  const texto = (question ?? '').trim()
  const interrogacoes = (texto.match(/\?/g) ?? []).length
  if (interrogacoes <= 1) return null

  const corte = texto.indexOf('?')
  return {
    motivo:
      'Há mais de uma pergunta neste campo. Uma pergunta por vez — quem visita procura a ' +
      'dúvida dele, e acha mais rápido quando cada uma tem o seu lugar.',
    sugestao: texto.slice(0, corte + 1).trim(),
  }
}
