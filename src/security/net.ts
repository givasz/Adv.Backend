// IP do cliente — usado como chave de rate limit.
//
// X-Forwarded-For é um cabeçalho que QUALQUER pessoa pode escrever. Confiar nele
// sem estar atrás de um proxy que o reescreve significa que trocar o cabeçalho a
// cada requisição zera todo limite de tentativas (login, denúncia, IA). Por isso
// ele só vale quando TRUST_PROXY estiver ligado — aí sim há um proxy (Nginx da
// VPS, Render) garantindo que o primeiro valor da lista é real.

const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true'

/**
 * IP do cliente.
 *
 * Nasceu como chave de rate limit e só isso — daí o aviso, que valeu até
 * 04/09/2026, de que nada dele era persistido. Deixou de valer: o registro de
 * acesso do art. 15 do Marco Civil (model AccessLog) e o aceite dos Termos
 * (User.termsIp) guardam o endereço. Fora desses dois lugares a regra antiga
 * continua inteira — nenhuma outra tabela recebe IP, e o visitante de perfil
 * público segue sem ser identificado.
 *
 * TRUST_PROXY importa mais agora: em produção, sem ele ligado, o endereço
 * gravado seria o do Nginx, e um registro que aponta para o próprio servidor não
 * cumpre obrigação nenhuma.
 */
export function clientIp(ip?: string, forwardedFor?: string): string {
  if (TRUST_PROXY) {
    const first = forwardedFor?.split(',')[0]?.trim()
    if (first) return first.slice(0, 60)
  }
  return (ip ?? '').slice(0, 60) || 'sem-ip'
}
