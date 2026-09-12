// O aviso ao buscador: sai só com chave e site https, nunca segura quem chama,
// e o que chega ao POST é o endereço PÚBLICO — nunca um Host de pedido.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { _limpar, _pendentes, avisarIndexNow, configIndexNow, enviar } from './indexnow'

const ENV = {
  INDEXNOW_KEY: '7c1f0b1e2a9d4f6b8e3c5a7d9f1b3e5c',
  SITE_URL: 'https://advoc.me',
} as NodeJS.ProcessEnv

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  _limpar()
})

describe('quando está ligado', () => {
  it('desligado sem chave, com chave inválida, ou com site sem https', () => {
    expect(configIndexNow({})).toBeNull()
    expect(configIndexNow({ INDEXNOW_KEY: 'curta', SITE_URL: 'https://advoc.me' })).toBeNull()
    expect(configIndexNow({ INDEXNOW_KEY: ENV.INDEXNOW_KEY, SITE_URL: 'http://localhost:5173' })).toBeNull()
    expect(configIndexNow({ INDEXNOW_KEY: ENV.INDEXNOW_KEY, FRONTEND_ORIGIN: 'https://advoc.me,https://x' })).toEqual({
      chave: ENV.INDEXNOW_KEY,
      site: 'https://advoc.me',
    })
  })

  it('desligado, não enfileira nada', () => {
    avisarIndexNow(['/ana-ribeiro'], {})
    expect(_pendentes()).toEqual([])
  })
})

describe('o envio', () => {
  it('manda um POST só, com as URLs públicas e a chave, e limpa a fila', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => new Response('', { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)

    avisarIndexNow(['/ana-ribeiro', '/escritorio/ribeiro-advogados', '/ana-ribeiro'], ENV)
    avisarIndexNow(['não é caminho', 'https://outro.site/x', '/x?y=1'], ENV)
    expect(_pendentes()).toEqual(['/ana-ribeiro', '/escritorio/ribeiro-advogados'])
    // Nada saiu ainda: o save não espera.
    expect(fetchMock).not.toHaveBeenCalled()

    expect(await enviar(ENV)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.indexnow.org/indexnow')
    const corpo = JSON.parse(init.body as string)
    expect(corpo).toEqual({
      host: 'advoc.me',
      key: ENV.INDEXNOW_KEY,
      keyLocation: `https://advoc.me/${ENV.INDEXNOW_KEY}.txt`,
      urlList: ['https://advoc.me/ana-ribeiro', 'https://advoc.me/escritorio/ribeiro-advogados'],
    })
    expect(_pendentes()).toEqual([])
  })

  it('falha de rede não estoura para quem chamou', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('rede caiu')
      }),
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    avisarIndexNow(['/ana-ribeiro'], ENV)
    await expect(enviar(ENV)).resolves.toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
