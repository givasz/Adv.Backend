// "Continuar com o Google" — as travas que não podem regredir:
//
//   • produção só liga com https e com a Política declarando o Google;
//   • o endereço de retorno sai do SITE_URL, nunca do pedido;
//   • o Google recebe o DESAFIO do PKCE, nunca o verificador;
//   • token para outro app, de outro emissor, de outro pedido ou vencido não entra;
//   • e-mail que o Google não confirmou não entra;
//   • cookie selado não se forja, não se troca de fase e vence;
//   • o `next` que atravessa o Google não vira trampolim para fora.

import { describe, expect, it, vi } from 'vitest'
import {
  abrirSelo,
  configDoGoogle,
  desafioPkce,
  destinoSeguro,
  lerIdToken,
  novoPedido,
  politicaDeclaraGoogle,
  selar,
  stateConfere,
  trocarCodigo,
  urlDeAutorizacao,
} from './google'

const CLIENT = '123456-abc.apps.googleusercontent.com'
const AGORA = Date.parse('2026-09-12T15:00:00Z')
const PROD = {
  NODE_ENV: 'production',
  GOOGLE_CLIENT_ID: CLIENT,
  GOOGLE_CLIENT_SECRET: 'GOCSPX-segredo',
  SITE_URL: 'https://advoc.me',
}

function token(claims: Record<string, unknown>): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.assinatura-qualquer`
}

const CLAIMS = {
  iss: 'https://accounts.google.com',
  aud: CLIENT,
  exp: AGORA / 1000 + 3600,
  iat: AGORA / 1000,
  nonce: 'nonce-do-pedido',
  sub: '109876543210987654321',
  email: 'Marina@Exemplo.com',
  email_verified: true,
  name: 'Marina Sales',
}

const ler = (mudar: Record<string, unknown> = {}) =>
  lerIdToken(token({ ...CLAIMS, ...mudar }), { clientId: CLIENT, nonce: 'nonce-do-pedido', agora: AGORA })

describe('configuração', () => {
  it('sem as chaves, desligado — e o motivo diz o que falta', () => {
    const c = configDoGoogle({ SITE_URL: 'https://advoc.me' })
    expect(c.ativo).toBe(false)
    expect(c.aviso).toMatch(/GOOGLE_CLIENT_ID/)
  })

  it('produção com https e Política em dia: ligado, com o retorno montado do SITE_URL', () => {
    const c = configDoGoogle(PROD)
    expect(c.ativo).toBe(true)
    expect(c.redirectUri).toBe('https://advoc.me/api/auth/google/retorno')
  })

  it('produção em http: desligado', () => {
    expect(configDoGoogle({ ...PROD, SITE_URL: 'http://advoc.me' }).ativo).toBe(false)
  })

  it('ID que não é do Google: desligado, em vez de mandar a pessoa a uma tela de erro do Google', () => {
    expect(configDoGoogle({ ...PROD, GOOGLE_CLIENT_ID: 'meu-app' }).ativo).toBe(false)
  })

  it('sem SITE_URL, o retorno usa a primeira origem de FRONTEND_ORIGIN', () => {
    const c = configDoGoogle({ ...PROD, SITE_URL: '', FRONTEND_ORIGIN: 'https://advoc.me,https://advocme.netlify.app' })
    expect(c.redirectUri).toBe('https://advoc.me/api/auth/google/retorno')
  })

  it('a Política precisa declarar o Google — versão com sufixo ordena depois da mesma data', () => {
    expect(politicaDeclaraGoogle('2026-09-12', '2026-09-12-2')).toBe(false)
    expect(politicaDeclaraGoogle('2026-09-12-2', '2026-09-12-2')).toBe(true)
    expect(politicaDeclaraGoogle('2026-10-01', '2026-09-12-2')).toBe(true)
    expect(politicaDeclaraGoogle('2026-10-01', null)).toBe(false)
  })
})

describe('a ida ao Google', () => {
  it('PKCE S256 confere com o vetor da RFC 7636', () => {
    expect(desafioPkce('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })

  it('o Google recebe state, nonce e o desafio — nunca o verificador', () => {
    const pedido = novoPedido()
    const url = new URL(urlDeAutorizacao(configDoGoogle(PROD), pedido))
    expect(url.origin).toBe('https://accounts.google.com')
    expect(url.searchParams.get('client_id')).toBe(CLIENT)
    expect(url.searchParams.get('redirect_uri')).toBe('https://advoc.me/api/auth/google/retorno')
    expect(url.searchParams.get('scope')).toBe('openid email profile')
    expect(url.searchParams.get('state')).toBe(pedido.state)
    expect(url.searchParams.get('nonce')).toBe(pedido.nonce)
    expect(url.searchParams.get('code_challenge')).toBe(desafioPkce(pedido.verifier))
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.toString()).not.toContain(pedido.verifier)
  })

  it('cada pedido sorteia valores novos, com tamanho aceito pelo PKCE (43+)', () => {
    const a = novoPedido()
    const b = novoPedido()
    expect(a.state).not.toBe(b.state)
    expect(a.verifier.length).toBeGreaterThanOrEqual(43)
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('state: só o mesmo valor, e só texto', () => {
    expect(stateConfere('abc', 'abc')).toBe(true)
    expect(stateConfere('abc', 'abd')).toBe(false)
    expect(stateConfere('abc', undefined)).toBe(false)
    expect(stateConfere('abc', ['abc'])).toBe(false)
  })
})

describe('a troca do código', () => {
  it('manda o verificador e a chave secreta ao Google, e devolve o token', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id_token: 'x.y.z' }), { status: 200 }))
    const t = await trocarCodigo(configDoGoogle(PROD), 'codigo', 'verificador', fetcher as unknown as typeof fetch)
    expect(t).toBe('x.y.z')
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://oauth2.googleapis.com/token')
    const corpo = new URLSearchParams(String(init.body))
    expect(corpo.get('code_verifier')).toBe('verificador')
    expect(corpo.get('client_secret')).toBe('GOCSPX-segredo')
    expect(corpo.get('grant_type')).toBe('authorization_code')
  })

  it('recusa sem vazar o corpo da resposta na mensagem de erro', async () => {
    const fetcher = vi.fn(async () => new Response('{"error":"invalid_grant","segredo":"abc"}', { status: 400 }))
    const erro = await trocarCodigo(configDoGoogle(PROD), 'c', 'v', fetcher as unknown as typeof fetch).catch((e) => e)
    expect(erro).toBeInstanceOf(Error)
    expect(String(erro.message)).not.toContain('segredo')
  })
})

describe('o token de identidade', () => {
  it('válido: devolve sub, e-mail em minúsculas e nome', () => {
    expect(ler()).toEqual({
      ok: true,
      identidade: { sub: CLAIMS.sub, email: 'marina@exemplo.com', nome: 'Marina Sales' },
    })
  })

  it.each([
    ['para outro app', { aud: 'outro.apps.googleusercontent.com' }],
    ['de outro emissor', { iss: 'https://login.exemplo.com' }],
    ['de outro pedido', { nonce: 'nonce-de-outro-pedido' }],
    ['sem nonce', { nonce: undefined }],
    ['vencido', { exp: AGORA / 1000 - 600 }],
    ['emitido no futuro', { iat: AGORA / 1000 + 3600 }],
    ['sem sub', { sub: undefined }],
    ['com e-mail inválido', { email: 'nao-e-email' }],
  ])('recusa token %s', (_nome, mudar) => {
    expect(ler(mudar)).toEqual({ ok: false, motivo: 'invalido' })
  })

  it('e-mail que o Google não confirmou não entra — é ele que liga a uma conta existente', () => {
    expect(ler({ email_verified: false })).toEqual({ ok: false, motivo: 'email-nao-confirmado' })
    expect(ler({ email_verified: undefined })).toEqual({ ok: false, motivo: 'email-nao-confirmado' })
  })

  it('aceita o "true" em texto dos tokens antigos e o aud em lista com azp', () => {
    expect(ler({ email_verified: 'true' }).ok).toBe(true)
    expect(ler({ aud: [CLIENT, 'outro'], azp: CLIENT }).ok).toBe(true)
    expect(ler({ aud: [CLIENT, 'outro'], azp: 'outro' }).ok).toBe(false)
  })

  it('lixo não derruba nada', () => {
    const opts = { clientId: CLIENT, nonce: 'n', agora: AGORA }
    expect(lerIdToken('', opts).ok).toBe(false)
    expect(lerIdToken('a.b', opts).ok).toBe(false)
    expect(lerIdToken('a.%%%.c', opts).ok).toBe(false)
    expect(lerIdToken(`a.${Buffer.from('[1,2]').toString('base64url')}.c`, opts).ok).toBe(false)
  })
})

describe('o cookie selado', () => {
  const identidade = { sub: '1', email: 'marina@exemplo.com', nome: 'Marina', lembrar: true, next: '/painel' }

  it('abre o que selou', () => {
    expect(abrirSelo(selar('identidade', identidade, 60_000), 'identidade')).toEqual(identidade)
  })

  it('não se forja: trocar o e-mail dentro do cookie invalida a assinatura', () => {
    const selado = selar('identidade', identidade, 60_000)
    const assinatura = selado.slice(selado.lastIndexOf('.') + 1)
    const corpoForjado = Buffer.from(
      JSON.stringify({ f: 'identidade', exp: Date.now() + 60_000, d: { ...identidade, email: 'vitima@exemplo.com' } }),
    ).toString('base64url')
    expect(abrirSelo(`${corpoForjado}.${assinatura}`, 'identidade')).toBeNull()
  })

  it('o selo do pedido não serve como identidade', () => {
    expect(abrirSelo(selar('pedido', identidade, 60_000), 'identidade')).toBeNull()
  })

  it('vence', () => {
    const selado = selar('identidade', identidade, 60_000, AGORA)
    expect(abrirSelo(selado, 'identidade', AGORA + 59_000)).not.toBeNull()
    expect(abrirSelo(selado, 'identidade', AGORA + 61_000)).toBeNull()
  })

  it('valor estranho → null, sem exceção', () => {
    for (const v of [undefined, '', 'sem-ponto', '.x', 'a'.repeat(5000), 'abc.def']) {
      expect(abrirSelo(v, 'identidade')).toBeNull()
    }
  })
})

describe('para onde a pessoa vai depois', () => {
  it.each([
    ['/painel', '/painel'],
    ['/editor?plan=pro', '/editor?plan=pro'],
    ['https://site-falso.com', '/painel'],
    ['//site-falso.com', '/painel'],
    ['/\\site-falso.com', '/painel'],
    ['/painel\n/outro', '/painel'],
    [undefined, '/painel'],
    [42, '/painel'],
  ])('%s → %s', (entrada, saida) => {
    expect(destinoSeguro(entrada)).toBe(saida)
  })
})
