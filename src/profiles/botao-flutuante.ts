// O botão que acompanha a rolagem no canto do perfil: o WhatsApp, o assistente
// virtual, ou nenhum. Um só — dois elementos perseguindo o visitante seriam o
// dobro do que a sobriedade do Prov. 205/2021 já tolera com esforço.
//
// Antes existia só o balão do assistente, num booleano (assistantFloating). A
// escolha nova mora em `floatingButton`, e as duas colunas convivem:
//   • NA GRAVAÇÃO, as duas são escritas — quem ainda lê só o booleano (um
//     cliente com o site antigo em cache) continua vendo a verdade;
//   • NA LEITURA, `floatingButton` nulo é perfil de antes da escolha, e aí vale o
//     booleano. É o que mantém ligado o balão de quem já o tinha, sem migração.

import { canUseScheduling, type Plan } from '../plans'

export type BotaoFlutuante = 'off' | 'whatsapp' | 'assistant'

const VALORES: readonly string[] = ['off', 'whatsapp', 'assistant']

const valido = (v: unknown): v is BotaoFlutuante => typeof v === 'string' && VALORES.includes(v)

/**
 * O que o corpo da requisição pediu.
 *
 * Com a chave `floating`, vale ela — e valor desconhecido desliga: um elemento
 * que segue o visitante não pode nascer de um corpo malformado. Sem a chave, é um
 * cliente antigo, e o pedido vem do balão de antes (`assistant.floating`).
 */
export function botaoFlutuanteDoCorpo(data: any): BotaoFlutuante {
  if (data && typeof data === 'object' && 'floating' in data) {
    return valido(data.floating) ? data.floating : 'off'
  }
  return data?.assistant?.floating === true ? 'assistant' : 'off'
}

/** As duas colunas, sempre coerentes entre si. */
export function colunasDoBotaoFlutuante(data: any) {
  const botao = botaoFlutuanteDoCorpo(data)
  return { floatingButton: botao, assistantFloating: botao === 'assistant' }
}

/** O que está gravado. Coluna nula (perfil anterior à escolha) lê o balão antigo. */
export function botaoFlutuanteGravado(p: any): BotaoFlutuante {
  if (valido(p?.floatingButton)) return p.floatingButton
  return p?.assistantFloating === true ? 'assistant' : 'off'
}

/**
 * O que o público recebe. Botão flutuante é recurso de plano pago (Pro e Max), e
 * a trava vale na LEITURA, como a do vídeo e a do FAQ: entre o vencimento da
 * assinatura e a varredura que reconcilia o banco existe uma janela, e o botão
 * não pode seguir no ar dentro dela.
 */
export function botaoFlutuantePublico(p: any, plano: Plan): BotaoFlutuante {
  return canUseScheduling(plano) ? botaoFlutuanteGravado(p) : 'off'
}
