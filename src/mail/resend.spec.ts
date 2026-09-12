// Cada resposta do Resend decide o destino do aviso na fila. Errar a
// classificação custa caro nos dois sentidos: tratar chave recusada como
// "permanente" descartaria todos os avisos de uma vez; tratar domínio não
// verificado como "passageiro" deixaria a fila tentando para sempre.

import { describe, expect, it } from 'vitest'
import { enviarPeloResend, semEnderecos, type EnvioResend } from './resend'

const ENVIO: EnvioResend = {
  apiKey: 're_teste',
  de: 'advoc.me <avisos@advoc.me>',
  para: 'marina@exemplo.com',
  assunto: 'Assunto',
  html: '<p>oi</p>',
  texto: 'oi',
  chaveDeIdempotencia: 'linha-1',
  etiqueta: 'redefinir-senha',
}

function responde(status: number, corpo: unknown, headers: Record<string, string> = {}): typeof fetch {
  return (async () => new Response(JSON.stringify(corpo), { status, headers })) as unknown as typeof fetch
}

describe('envio pelo Resend', () => {
  it('aceito: devolve o id, e o pedido leva chave, idempotência e destinatário em lista', async () => {
    let url = ''
    let init: RequestInit | undefined
    const f = (async (u: RequestInfo | URL, i?: RequestInit) => {
      url = String(u)
      init = i
      return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 })
    }) as unknown as typeof fetch

    expect(await enviarPeloResend(ENVIO, f)).toEqual({ ok: true, id: 'em_1' })
    expect(url).toBe('https://api.resend.com/emails')
    const h = new Headers(init!.headers)
    expect(h.get('authorization')).toBe('Bearer re_teste')
    expect(h.get('idempotency-key')).toBe('linha-1')
    const corpo = JSON.parse(String(init!.body))
    expect(corpo.to).toEqual(['marina@exemplo.com'])
    expect(corpo.tags).toEqual([{ name: 'modelo', value: 'redefinir-senha' }])
  })

  it.each([
    [429, { name: 'daily_quota_exceeded' }, 'cota'],
    [429, { name: 'rate_limit_exceeded' }, 'transitorio'],
    [401, { name: 'missing_api_key' }, 'credencial'],
    [403, { name: 'invalid_api_key' }, 'credencial'],
    [403, { name: 'restricted_api_key' }, 'credencial'],
    [403, { name: 'validation_error', message: 'The advoc.me domain is not verified.' }, 'permanente'],
    [422, { name: 'validation_error' }, 'permanente'],
    [409, { name: 'concurrent_idempotent_requests' }, 'transitorio'],
    [500, { name: 'internal_server_error' }, 'transitorio'],
  ])('%i %o → %s', async (status, corpo, tipo) => {
    const r = await enviarPeloResend(ENVIO, responde(status, corpo))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.tipo).toBe(tipo)
  })

  it('o "tente depois" do provedor vira espera', async () => {
    const r = await enviarPeloResend(ENVIO, responde(429, { name: 'rate_limit_exceeded' }, { 'retry-after': '3' }))
    expect(!r.ok && r.esperarMs).toBe(3000)
  })

  it('rede fora: passageiro', async () => {
    const f = (async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch
    const r = await enviarPeloResend(ENVIO, f)
    expect(!r.ok && r.tipo).toBe('transitorio')
  })

  it('sem resposta no prazo: desiste da chamada e trata como passageiro', async () => {
    const f = ((_u: unknown, init?: RequestInit) =>
      new Promise((_ok, falha) => {
        init!.signal!.addEventListener('abort', () => falha(new Error('abortado')))
      })) as unknown as typeof fetch
    const r = await enviarPeloResend(ENVIO, f, 20)
    expect(!r.ok && r.tipo).toBe('transitorio')
    expect(!r.ok && r.erro).toMatch(/sem resposta/)
  })

  it('o erro guardado não leva endereço de e-mail', async () => {
    const r = await enviarPeloResend(
      ENVIO,
      responde(403, {
        name: 'validation_error',
        message: 'You can only send testing emails to your own email address (dono@gmail.com).',
      }),
    )
    expect(!r.ok && r.erro).not.toContain('dono@gmail.com')
    expect(semEnderecos('para a@b.com e c.d@e.com.br')).toBe('para <e-mail> e <e-mail>')
  })
})
