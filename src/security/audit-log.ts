// Registro de eventos de segurança — entrada, cadastro, recusa de acesso, teto de
// tentativas. Linha única em JSON, que é o formato que qualquer coletor de log
// (journalctl, pm2, Loki) consegue filtrar depois.
//
// O que NUNCA entra aqui: senha, token, corpo da requisição e o e-mail em si. Um
// log é um lugar onde dado pessoal vaza sem ninguém perceber — e um arquivo de
// log com e-mails é a mesma lista de clientes que a proteção contra enumeração
// tenta esconder. Para correlacionar tentativas contra a MESMA conta sem guardar
// o endereço, usamos uma impressão digital curta e irreversível.

import { createHash } from 'node:crypto'

export type SecurityEvent =
  | 'login_ok'
  | 'login_fail'
  | 'signup_ok'
  | 'signup_fail'
  | 'logout'
  | 'logout_all'
  | 'password_changed'
  | 'account_export'
  | 'account_delete'
  | 'admin_login_ok'
  | 'admin_login_fail'
  | 'admin_logout'
  | 'rate_limited'
  | 'access_denied'

interface Registro {
  event: SecurityEvent
  ip?: string
  /** id do usuário autenticado, quando existe */
  userId?: string
  /** impressão digital do e-mail (não é o e-mail) */
  subject?: string
  resource?: string
  result: 'ok' | 'negado'
  userAgent?: string
}

/** Impressão digital curta e irreversível de um identificador (e-mail, geralmente). */
export function fingerprint(valor?: string): string | undefined {
  const v = (valor ?? '').trim().toLowerCase()
  if (!v) return undefined
  return createHash('sha256').update(v).digest('hex').slice(0, 12)
}

export function logSecurityEvent(r: Registro): void {
  const linha = {
    ts: new Date().toISOString(),
    kind: 'security',
    ...r,
    userAgent: r.userAgent?.slice(0, 180),
  }
  // console é o transporte: no pm2/systemd a saída padrão já vai para arquivo com
  // rotação. Um logger próprio aqui só acrescentaria dependência.
  console.log(JSON.stringify(linha))
}
