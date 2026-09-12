// Quem entrega os e-mails da plataforma — e se ela PODE entregar.
//
// Três modos, decididos no boot a partir do ambiente:
//
//   resend    → envio de verdade, pela API do Resend (resend.com).
//   console   → só em desenvolvimento, sem RESEND_API_KEY: a mensagem inteira,
//               com o link, sai no terminal. É o que deixa testar "esqueci minha
//               senha" na máquina local sem conta em provedor nenhum.
//   desligado → nada sai. Os avisos ficam na fila (MailOutbox) e saem quando o
//               correio for ligado; os links com prazo vencem sozinhos.
//
// POR QUE A POLÍTICA DE PRIVACIDADE ENTRA NA CONTA
// ------------------------------------------------
// Mandar e-mail pelo Resend é entregar o endereço e o conteúdo do aviso a um
// operador, fora do Brasil. A Política de Privacidade lista quem trata dado da
// pessoa, e um operador que não está na lista é a política mentindo — o mesmo
// defeito que tirou o `contato@advoc.me` dos documentos (SEGURANCA.md, item 6).
//
// Então, em produção, a chave sozinha não liga nada: a versão vigente dos
// documentos precisa ser a que declara o provedor. Ligar o correio é trocar
// CORREIO_NA_POLITICA_DESDE junto com o texto e a versão dos Termos — a trava de
// paridade (legal/termos.spec.ts) confere que o texto de fato o menciona.

import { TERMS_VERSION } from '../legal/termos'

export type ModoDoCorreio = 'resend' | 'console' | 'desligado'

export interface ConfigDoCorreio {
  modo: ModoDoCorreio
  /** Há entrega — de verdade ou no console do desenvolvimento? */
  ativo: boolean
  apiKey: string
  /** "advoc.me <avisos@dominio>" — o domínio precisa estar verificado no Resend. */
  remetente: string
  /** Base de todo link que vai num e-mail. Nunca vem do pedido (Host), só daqui. */
  siteUrl: string
  /** Quantos e-mails o plano do provedor aguenta por dia (o grátis do Resend: 100). */
  tetoDiario: number
  /** Por que está desligado, ou o alerta que merece ser lido no boot. */
  aviso: string
}

/**
 * A partir de qual versão dos Termos a Política de Privacidade declara o
 * provedor de e-mail. `null` = ainda não declara, e em produção nada sai.
 */
export const CORREIO_NA_POLITICA_DESDE: string | null = null

/** A versão vigente dos documentos já declara o provedor de e-mail? */
export function politicaDeclaraCorreio(
  versao: string = TERMS_VERSION,
  desde: string | null = CORREIO_NA_POLITICA_DESDE,
): boolean {
  // Datas ISO comparam como texto: "2026-10-01" >= "2026-09-12".
  return desde !== null && versao >= desde
}

const REMETENTE_PADRAO_DEV = 'advoc.me <onboarding@resend.dev>'

/** "Nome <a@b.c>" ou "a@b.c". Sem quebra de linha: remetente é cabeçalho. */
export function remetenteValido(valor: string): boolean {
  if (!valor || /[\r\n]/.test(valor) || valor.length > 200) return false
  return /^(?:[^<>@]{1,80}\s)?<?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(valor)
}

function dominioDe(remetente: string): string {
  return /@([^\s@<>]+)>?$/.exec(remetente)?.[1]?.toLowerCase() ?? ''
}

/**
 * Endereço do site para montar os links. SITE_URL quando existe; senão a
 * primeira origem de FRONTEND_ORIGIN, que em produção é obrigatória.
 *
 * Nunca o cabeçalho Host do pedido: um "esqueci minha senha" com Host forjado
 * mandaria à vítima um link verdadeiro apontando para o site de quem forjou —
 * e o token de redefinição iria junto.
 */
export function urlDoSite(env: NodeJS.ProcessEnv = process.env): string {
  const bruto =
    (env.SITE_URL ?? '').trim() ||
    (env.FRONTEND_ORIGIN ?? '').split(',')[0]?.trim() ||
    'http://localhost:5173'
  try {
    const u = new URL(bruto)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return ''
    return `${u.protocol}//${u.host}`
  } catch {
    return ''
  }
}

function inteiroPositivo(valor: string | undefined, padrao: number): number {
  const n = Number.parseInt((valor ?? '').trim(), 10)
  return Number.isFinite(n) && n > 0 ? n : padrao
}

export function configDoCorreio(env: NodeJS.ProcessEnv = process.env): ConfigDoCorreio {
  const prod = env.NODE_ENV === 'production'
  const apiKey = (env.RESEND_API_KEY ?? '').trim()
  const siteUrl = urlDoSite(env)
  const tetoDiario = inteiroPositivo(env.MAIL_TETO_DIA, 100)
  let remetente = (env.MAIL_FROM ?? '').trim()

  const base = { apiKey, siteUrl, tetoDiario }
  const desligado = (aviso: string): ConfigDoCorreio => ({
    ...base,
    modo: 'desligado',
    ativo: false,
    remetente,
    aviso,
  })

  if (!siteUrl) return desligado('SITE_URL/FRONTEND_ORIGIN não é um endereço http(s) válido.')

  if (!apiKey) {
    if (prod) return desligado('RESEND_API_KEY ausente.')
    return {
      ...base,
      modo: 'console',
      ativo: true,
      remetente: remetente || REMETENTE_PADRAO_DEV,
      aviso: 'sem RESEND_API_KEY — as mensagens saem no console, com o link.',
    }
  }

  if (!remetenteValido(remetente)) {
    if (prod) return desligado('MAIL_FROM ausente ou inválido (formato: "advoc.me <avisos@seu-dominio>").')
    remetente = REMETENTE_PADRAO_DEV
  }

  if (prod) {
    if (!politicaDeclaraCorreio()) {
      return desligado(
        'a Política de Privacidade ainda não declara o provedor de e-mail. ' +
          'Ver CORREIO_NA_POLITICA_DESDE em src/mail/config.ts.',
      )
    }
    // Link de redefinir senha em http viaja em texto claro por qualquer rede.
    if (!siteUrl.startsWith('https://')) return desligado('SITE_URL precisa ser https em produção.')
  }

  const aviso =
    dominioDe(remetente) === 'resend.dev'
      ? 'MAIL_FROM usa @resend.dev: o Resend só entrega no e-mail do dono da conta dele. Verifique um domínio.'
      : ''
  return { ...base, modo: 'resend', ativo: true, remetente, aviso }
}

/** A linha do boot. Nada de chave: só o que ajuda a conferir o deploy. */
export function descreverCorreio(c: ConfigDoCorreio): string {
  if (c.modo === 'desligado') return `DESLIGADO — ${c.aviso} Nenhum e-mail sai; os avisos esperam na fila.`
  const partes = [
    c.modo === 'resend' ? 'Resend' : 'console (desenvolvimento)',
    `de ${c.remetente}`,
    `links para ${c.siteUrl}`,
    `teto ${c.tetoDiario}/dia`,
  ]
  return partes.join(' · ') + (c.aviso ? ` · ⚠️ ${c.aviso}` : '')
}
