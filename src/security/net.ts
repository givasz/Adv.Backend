// IP do cliente — usado como chave de rate limit.
//
// X-Forwarded-For é um cabeçalho que QUALQUER pessoa pode escrever. Confiar nele
// sem estar atrás de um proxy que o reescreve significa que trocar o cabeçalho a
// cada requisição zera todo limite de tentativas (login, denúncia, IA). Por isso
// ele só vale quando TRUST_PROXY estiver ligado — aí sim há um proxy (Nginx da
// VPS, Render) garantindo que o primeiro valor da lista é real.

const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true'

/** IP do cliente para fins de limite. Nunca é persistido. */
export function clientIp(ip?: string, forwardedFor?: string): string {
  if (TRUST_PROXY) {
    const first = forwardedFor?.split(',')[0]?.trim()
    if (first) return first.slice(0, 60)
  }
  return (ip ?? '').slice(0, 60) || 'sem-ip'
}
