// Versão vigente dos documentos legais, do lado que DECIDE.
//
// O texto dos documentos mora no front (frontend/src/lib/legalContent.ts) porque
// é ele quem desenha as páginas. A VERSÃO, não: ela precisa existir aqui, porque
// é o servidor que grava o aceite e é o servidor que recusa um cadastro sem ele.
//
// Se a versão viesse no corpo da requisição, o cliente escolheria qual contrato
// assinou — bastaria mandar a string do documento antigo para nunca mais ver o
// pedido de reaceite. Aqui, o corpo só pode dizer "aceito"; QUAL documento foi
// aceito é decisão de quem grava.
//
// A paridade com o front é travada por legal/termos.spec.ts, que lê o arquivo do
// outro lado e compara. Mudar um sem o outro quebra o teste — que é exatamente o
// que se quer: um aceite carimbado com uma versão que a tela não exibe é um
// registro que aponta para o vazio.

/** Versão vigente — é a data da revisão. Espelha TERMS_VERSION do front. */
export const TERMS_VERSION = '2026-09-12'

/**
 * Quem opera a plataforma — espelha OPERADOR do front (frontend/src/lib/legalIdentity.ts).
 *
 * Mora aqui para o rodapé dos e-mails: um aviso que diz "sua conta foi suspensa"
 * sem dizer QUEM está falando é indistinguível de golpe, e é parte identificada
 * que o CDC pede em toda comunicação com o consumidor. A paridade com o front é
 * conferida em termos.spec.ts.
 */
export const OPERADOR = {
  razaoSocial: 'VEACCI SERVIÇOS DE T.I LTDA — ME',
  cnpj: '43.563.547/0001-08',
} as const

/**
 * O aceite gravado ainda vale?
 *
 * Comparação por igualdade, e não "é mais nova que": uma conta carimbada com uma
 * versão que não é a atual — mais velha, ou mais nova depois de um rollback —
 * precisa aceitar de novo. Vazio (contas criadas antes de existir aceite) também
 * cai aqui, e é o caminho pelo qual a base inteira passa a ter registro.
 */
export function aceiteVigente(versaoGravada?: string | null): boolean {
  return (versaoGravada ?? '') === TERMS_VERSION
}
