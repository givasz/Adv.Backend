// Os modelos de documento que o servidor aceita registrar — e a revisão de cada um.
//
// O TEXTO dos modelos mora no front (frontend/src/lib/contratos/modelos.ts),
// porque a minuta é montada no aparelho e nunca viaja para cá. O que o servidor
// precisa saber é só QUAL modelo e QUAL revisão dele o advogado usou: é isso que
// fica no registro e é isso que permite, anos depois, dizer de que texto-base
// aquele contrato partiu.
//
// ⚠️ MANTER EM PARIDADE com o front. `modelos.spec.ts` lê o arquivo de lá e falha
// se uma revisão mudar num lado e não no outro — um registro carimbado com uma
// versão que o servidor não conhece é um registro que ninguém consegue rastrear.

export const MODELOS_DE_DOCUMENTO = {
  honorarios: '2026-09-10',
  procuracao: '2026-09-10',
  substabelecimento: '2026-09-10',
  hipossuficiencia: '2026-09-10',
} as const

export type ModeloDeDocumento = keyof typeof MODELOS_DE_DOCUMENTO

export const MODELOS_LISTA = Object.keys(MODELOS_DE_DOCUMENTO) as ModeloDeDocumento[]

/**
 * Documento montado a partir de um MODELO PRÓPRIO do advogado. Não tem revisão
 * de data: a "versão" é "p:" + 16 hex do SHA-256 do texto do modelo usado,
 * calculado no aparelho — o modelo pode mudar depois, e o registro continua
 * apontando para o texto exato de que aquele documento partiu.
 */
export const MODELO_PROPRIO = 'proprio'
export const VERSAO_DE_MODELO_PROPRIO = /^p:[0-9a-f]{16}$/

/**
 * Revisão do texto da declaração que o advogado confirma antes de registrar
 * ("revisei o documento inteiro" e "o conteúdo é de minha responsabilidade").
 * Mudou a frase no front? Mude a data nos dois lados.
 */
export const DECLARACAO_DE_REVISAO_VERSAO = '2026-09-10'

export const ETAPAS_DE_REGISTRO = ['revisado', 'assinado'] as const
export type EtapaDeRegistro = (typeof ETAPAS_DE_REGISTRO)[number]

/**
 * Código impresso no rodapé: "AVM-" + 8 símbolos do alfabeto de Crockford (sem
 * I, L, O e U, que se confundem com 1, 0 e V quando alguém dita o código ao
 * telefone). 40 bits: colisão é rara, e o servidor recusa se acontecer.
 */
export const CODIGO_DE_REGISTRO = /^AVM-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/

/** SHA-256 em hexadecimal minúsculo. */
export const HASH_SHA256 = /^[0-9a-f]{64}$/

/** Teto de sanidade: um contrato em texto não chega perto disto. */
export const TAMANHO_MAXIMO_BYTES = 50 * 1024 * 1024
