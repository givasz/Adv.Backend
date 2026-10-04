// IP do cliente — usado como chave de rate limit.
//
// X-Forwarded-For é um cabeçalho que QUALQUER pessoa pode escrever. Confiar nele
// sem estar atrás de um proxy que o reescreve significa que trocar o cabeçalho a
// cada requisição zera todo limite de tentativas (login, denúncia, IA). Por isso
// ele nunca é lido diretamente aqui. O Express resolve `req.ip` usando exatamente
// um salto confiável configurado em main.ts; valores extras do cliente ficam fora.

/**
 * IP do cliente.
 *
 * Nasceu como chave de rate limit e só isso — daí o aviso, que valeu até
 * 04/09/2026, de que nada dele era persistido. Deixou de valer: o registro de
 * acesso do art. 15 do Marco Civil (model AccessLog) e o aceite dos Termos
 * (User.termsIp) guardam o endereço. Em 10/09/2026 entrou o terceiro, pelo mesmo
 * motivo do aceite: a declaração de revisão de um documento
 * (RegistroDocumento.ip). Fora desses três lugares a regra antiga
 * continua inteira — nenhuma outra tabela recebe IP, e o visitante de perfil
 * público segue sem ser identificado.
 *
 * TRUST_PROXY importa mais agora: em produção, sem ele ligado, o endereço
 * gravado seria o do Nginx, e um registro que aponta para o próprio servidor não
 * cumpre obrigação nenhuma.
 */
export function clientIp(ip?: string, forwardedFor?: string): string {
  void forwardedFor
  return (ip ?? '').slice(0, 60) || 'sem-ip'
}
