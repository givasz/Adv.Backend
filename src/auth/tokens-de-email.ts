// Links de uma vez só — confirmar o e-mail e redefinir a senha.
//
// Mesmo desenho da sessão (ver user-auth.ts): o link leva um segredo sorteado de
// 256 bits e o banco guarda só o SHA-256 dele. Um dump do Postgres não confirma
// e-mail nem troca senha de ninguém.
//
// Três propriedades, e cada uma fecha um caminho:
//
//   • PRAZO CURTO na redefinição (1 hora). Link de trocar senha parado numa caixa
//     de entrada é uma chave debaixo do tapete.
//   • UM LINK VIVO POR VEZ. Pedir outro mata o anterior — senão cinco pedidos
//     seguidos deixariam cinco chaves valendo ao mesmo tempo.
//   • GASTO ATÔMICO. Dois cliques simultâneos (o de quem recebeu e o de quem
//     interceptou) não trocam a senha duas vezes: um `updateMany` condicionado a
//     "ainda não usado" deixa passar exatamente um.

import { randomBytes } from 'node:crypto'
import type { PrismaService } from '../prisma/prisma.service'
import { hashCredencial } from './user-auth'

export type TipoDeToken = 'confirmar' | 'redefinir'

export const VALIDADE_HORAS: Record<TipoDeToken, number> = {
  confirmar: 48,
  redefinir: 1,
}

const HORA = 60 * 60 * 1000

type Banco = Pick<PrismaService, 'emailToken'>

/** 32 bytes em base64url são 43 caracteres. Outra forma nem chega ao banco. */
export function formatoDeToken(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v)
}

export async function emitirToken(
  prisma: Banco,
  userId: string,
  email: string,
  tipo: TipoDeToken,
  agora = Date.now(),
): Promise<{ token: string; expiraEm: Date }> {
  const token = randomBytes(32).toString('base64url')
  const expiraEm = new Date(agora + VALIDADE_HORAS[tipo] * HORA)
  await prisma.emailToken.deleteMany({ where: { userId, tipo, usadoEm: null } })
  await prisma.emailToken.create({
    data: { userId, tipo, email, expiraEm, tokenHash: hashCredencial(token) },
  })
  return { token, expiraEm }
}

export interface TokenValido {
  id: string
  userId: string
  /** O endereço para o qual o link foi enviado. */
  email: string
}

/** O link ainda vale? Não gasta — quem gasta é `gastarToken`, no último passo. */
export async function conferirToken(
  prisma: Banco,
  token: unknown,
  tipo: TipoDeToken,
  agora = Date.now(),
): Promise<TokenValido | null> {
  if (!formatoDeToken(token)) return null
  const t = await prisma.emailToken.findUnique({
    where: { tokenHash: hashCredencial(token) },
    select: { id: true, userId: true, email: true, tipo: true, expiraEm: true, usadoEm: true },
  })
  if (!t || t.tipo !== tipo || t.usadoEm || t.expiraEm.getTime() <= agora) return null
  return { id: t.id, userId: t.userId, email: t.email }
}

/** Gasta o link. `true` só para UM pedido, por mais que cheguem juntos. */
export async function gastarToken(prisma: Banco, id: string): Promise<boolean> {
  const { count } = await prisma.emailToken.updateMany({
    where: { id, usadoEm: null },
    data: { usadoEm: new Date() },
  })
  return count === 1
}
