import { afterEach, describe, expect, it, vi } from 'vitest'

const original = process.env.TRUST_PROXY

afterEach(() => {
  if (original === undefined) delete process.env.TRUST_PROXY
  else process.env.TRUST_PROXY = original
  vi.resetModules()
})

describe('IP do cliente atrás do proxy', () => {
  it('usa o IP já resolvido pelo Express e ignora X-Forwarded-For fornecido pelo cliente', async () => {
    process.env.TRUST_PROXY = '1'
    vi.resetModules()
    const { clientIp } = await import('./net')

    expect(clientIp('198.51.100.10', '6.6.6.6, 198.51.100.10')).toBe('198.51.100.10')
  })
})
