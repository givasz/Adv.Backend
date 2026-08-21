// Cabeçalhos de segurança em TODA resposta da API.
//
// Escrito à mão (em vez de `helmet`) porque a superfície aqui é mínima: a API só
// devolve JSON, nunca HTML. O CSP correspondente é `default-src 'none'` — uma
// resposta desta origem não deve poder carregar ou executar coisa nenhuma nem
// quando alguém a abre direto no navegador.
//
// O CSP da PÁGINA (que é quem realmente executa script) fica no frontend:
// frontend/netlify.toml.

import { IS_PROD } from './config'

// Tipagem estrutural mínima (sem depender de @types/express): é só o que o
// middleware usa.
interface Resposta {
  setHeader(nome: string, valor: string): void
  removeHeader(nome: string): void
}

export function securityHeaders(_req: unknown, res: Resposta, next: () => void): void {
  // Resposta JSON não carrega nada nem pode ser enquadrada.
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site')
  // Dados de perfil/conta não devem ficar em cache compartilhado.
  res.setHeader('Cache-Control', 'no-store')
  if (IS_PROD) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload')
  }
  // Não anunciar o framework (X-Powered-By é desligado no app; aqui é a garantia).
  res.removeHeader('X-Powered-By')
  next()
}
