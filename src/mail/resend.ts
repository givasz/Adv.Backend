// O envio pela API do Resend — e o que cada resposta quer dizer para a fila.
//
// Sem o SDK de propósito: é um POST com JSON. Uma dependência a mais para isso
// seria mais código de terceiro rodando com a chave na mão, e nada que o `fetch`
// do Node não faça.
//
// A parte que importa é a CLASSIFICAÇÃO da falha, porque é ela que decide o
// destino do aviso na fila:
//
//   transitorio → tenta de novo mais tarde (rede, 5xx, limite por segundo);
//   cota        → o plano estourou a cota do dia: o provedor inteiro espera;
//   credencial  → a chave foi recusada: o provedor inteiro espera, e NENHUM aviso
//                 é descartado — trocar a chave faz a fila andar de novo;
//   permanente  → este envio nunca vai passar (endereço inválido, domínio não
//                 verificado): marca como falha e segue.

const ENDERECO = 'https://api.resend.com/emails'
const TEMPO_MS = 10_000

export interface EnvioResend {
  apiKey: string
  de: string
  para: string
  assunto: string
  html: string
  texto: string
  /**
   * O id da linha da fila. O Resend guarda a chave por 24 h: se o processo cair
   * depois de o provedor aceitar e antes de marcarmos "enviado", a repetição não
   * vira um segundo e-mail na caixa da pessoa.
   */
  chaveDeIdempotencia: string
  /** Nome do modelo — só letras, números, hífen e sublinhado. */
  etiqueta: string
}

export type ResultadoEnvio =
  | { ok: true; id: string }
  | {
      ok: false
      tipo: 'transitorio' | 'cota' | 'credencial' | 'permanente'
      status: number
      erro: string
      /** Quanto esperar antes de tentar de novo, quando o provedor diz. */
      esperarMs?: number
    }

const HORA = 60 * 60 * 1000

/** Erro do provedor pode repetir o endereço — o registro guarda o motivo, não o e-mail. */
export function semEnderecos(texto: string): string {
  return texto.replace(/[^\s@<>()"',;:]+@[^\s@<>()"',;:]+/g, '<e-mail>').slice(0, 300)
}

export async function enviarPeloResend(
  e: EnvioResend,
  fetchImpl: typeof fetch = fetch,
  tempoMs = TEMPO_MS,
): Promise<ResultadoEnvio> {
  const abortar = new AbortController()
  const relogio = setTimeout(() => abortar.abort(), tempoMs)
  let res: Response
  try {
    res = await fetchImpl(ENDERECO, {
      method: 'POST',
      signal: abortar.signal,
      headers: {
        Authorization: `Bearer ${e.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': e.chaveDeIdempotencia.slice(0, 256),
      },
      body: JSON.stringify({
        from: e.de,
        to: [e.para],
        subject: e.assunto,
        html: e.html,
        text: e.texto,
        tags: [{ name: 'modelo', value: e.etiqueta.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256) }],
      }),
    })
  } catch (err) {
    const erro = abortar.signal.aborted ? `sem resposta em ${tempoMs} ms` : `rede: ${String(err)}`
    return { ok: false, tipo: 'transitorio', status: 0, erro: semEnderecos(erro) }
  } finally {
    clearTimeout(relogio)
  }

  let corpo: { id?: unknown; name?: unknown; message?: unknown } = {}
  try {
    corpo = (await res.json()) as typeof corpo
  } catch {
    /* corpo vazio ou não-JSON: a classificação fica pelo status */
  }

  if (res.ok) return { ok: true, id: typeof corpo.id === 'string' ? corpo.id : '' }

  const nome = typeof corpo.name === 'string' ? corpo.name : ''
  const erro = semEnderecos(`${res.status} ${nome}: ${typeof corpo.message === 'string' ? corpo.message : ''}`)
  const falha = (tipo: 'transitorio' | 'cota' | 'credencial' | 'permanente', esperarMs?: number) =>
    ({ ok: false, tipo, status: res.status, erro, esperarMs }) as const

  if (res.status === 429) {
    if (/quota/i.test(nome)) return falha('cota', HORA)
    const segundos = Number(res.headers.get('retry-after'))
    return falha('transitorio', Number.isFinite(segundos) && segundos > 0 ? segundos * 1000 : 2000)
  }
  // O Resend recusa chave ausente com 401 e chave inválida/restrita com 403 —
  // mas também usa 403 para "domínio não verificado", que é deste envio e não
  // da chave. Por isso o nome do erro decide, e não o número.
  if (res.status === 401 || /api_key/i.test(nome)) return falha('credencial', 10 * 60 * 1000)
  if (res.status === 409 && /concurrent/i.test(nome)) return falha('transitorio', 2000)
  if (res.status >= 500) return falha('transitorio')
  return falha('permanente')
}
