// Gravação do registro de acesso (Marco Civil, art. 15). O porquê do registro
// existir está no comentário do model AccessLog, em prisma/schema.prisma.
//
// Função solta, não um provider do Nest, pelo mesmo motivo de logSecurityEvent
// ao lado: quem chama já tem um PrismaService na mão, e um módulo novo só para
// carregar uma função de três linhas atravessaria o grafo de dependências de
// auth, profiles e account sem entregar nada.

import type { PrismaService } from '../prisma/prisma.service'
import { checkRateLimit } from './rate-limit'
import { fingerprint, logSecurityEvent } from './audit-log'

/**
 * Os quatro momentos registrados. Deliberadamente poucos.
 *
 *   login / signup → quem entrou na conta, de onde. É o mínimo do art. 15.
 *   publicacao     → o instante em que um perfil foi ao ar. É o ato que coloca
 *                    conteúdo no mundo, e o único que uma vítima de perfil falso
 *                    vai querer datar.
 *   edicao         → alteração de um perfil JÁ público. Sem isto, quem publica
 *                    um perfil correto e depois o reescreve para algo ilícito
 *                    ficaria coberto pelo registro da publicação original.
 *
 * O que NÃO entra: leitura, navegação, visita a perfil público. O art. 15 fala
 * de registro de acesso à aplicação, não de vigilância de uso — e o visitante
 * continua não sendo identificado em lugar nenhum (ver analytics/eventos.ts).
 */
export type AcessoAction = 'login' | 'signup' | 'publicacao' | 'edicao'

export interface RegistroDeAcesso {
  userId?: string
  /** e-mail em claro — vira impressão digital aqui dentro, nunca é gravado */
  email?: string
  action: AcessoAction
  ip: string
  userAgent?: string
}

/**
 * Grava uma linha. Nunca deixa a falha subir.
 *
 * Um erro de banco aqui não pode derrubar um login: a pessoa não tem culpa da
 * nossa obrigação legal, e recusar a entrada por causa dela seria transformar um
 * dever nosso em indisponibilidade dela. Mas também não pode sumir em silêncio —
 * daí cair no log de segurança, que vai para o arquivo do pm2 e ao menos deixa
 * rastro de que houve acesso e de que o registro falhou.
 */
export async function registrarAcesso(
  prisma: PrismaService,
  r: RegistroDeAcesso,
): Promise<void> {
  try {
    await prisma.accessLog.create({
      data: {
        userId: r.userId ?? '',
        subject: fingerprint(r.email) ?? '',
        action: r.action,
        ip: r.ip.slice(0, 60),
        userAgent: (r.userAgent ?? '').slice(0, 180),
      },
    })
  } catch (e) {
    logSecurityEvent({
      event: 'access_log_fail',
      ip: r.ip,
      userId: r.userId,
      subject: fingerprint(r.email),
      resource: `${r.action}: ${e instanceof Error ? e.message : e}`,
      result: 'negado',
    })
  }
}

/**
 * O editor salva com debounce: uma sessão de trabalho de dez minutos dispara
 * dezenas de PUT. Uma linha de registro por tecla digitada não é registro, é
 * ruído — e ruído com IP dentro, que é a pior combinação possível.
 *
 * A janela é de trinta minutos por conta. O que se quer datar é "esta conta
 * mexeu no perfil público naquela tarde, deste endereço"; a granularidade fina de
 * o QUE mudou já é do AuditLog, que guarda o retrato da bio por um ano.
 *
 * Vive na memória do processo (o mesmo limitador do resto). Reiniciar a API zera
 * a janela e, no pior caso, grava uma linha a mais — errar para o lado de
 * registrar demais é o lado certo de errar aqui.
 */
export function devoRegistrarEdicao(userId: string): boolean {
  return checkRateLimit(`acesso:edicao:${userId}`, { windowMs: 30 * 60_000, max: 1 })
}
