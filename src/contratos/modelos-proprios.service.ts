// Modelos próprios do advogado — criar, listar, editar e excluir.
//
// Três regras, na ordem em que valem:
//
//   1. SÓ TEXTO. Todo modelo passa por lerModeloProprio(), que recusa o que
//      parece dado pessoal (ver dado-pessoal.ts). O dado do cliente é pedido a
//      cada documento, no aparelho.
//
//   2. MAX, ATÉ 3 — pelo plano VIGENTE do banco. Criar e editar são do Max;
//      listar e excluir, não: descer de plano esconde sem apagar, e apagar o que
//      é seu nunca pode depender de estar pagando (LGPD, art. 18).
//
//   3. SÓ O DONO. Um modelo de outra conta responde 404 — nem "existe e não é
//      seu", que diria a um curioso que aquele id existe.

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { planoVigente } from '../assinatura'
import { MODELOS_PROPRIOS_LIMITE, canUseContratos } from '../plans'
import { lerModeloProprio, type ClausulaDoModeloProprio } from './modelo-proprio'

const CAMPOS = {
  id: true,
  nome: true,
  quemAssina: true,
  titulo: true,
  clausulas: true,
  revisao: true,
  createdAt: true,
  updatedAt: true,
} as const

type Linha = {
  id: string
  nome: string
  quemAssina: string
  titulo: string
  clausulas: string
  revisao: number
  createdAt: Date
  updatedAt: Date
}

function lerClausulas(json: string): ClausulaDoModeloProprio[] {
  try {
    const l = JSON.parse(json)
    return Array.isArray(l)
      ? l.map((c) => ({ titulo: String(c?.titulo ?? ''), texto: String(c?.texto ?? '') }))
      : []
  } catch {
    return []
  }
}

function paraODono(l: Linha) {
  return {
    id: l.id,
    nome: l.nome,
    quemAssina: l.quemAssina,
    titulo: l.titulo,
    clausulas: lerClausulas(l.clausulas),
    revisao: l.revisao,
    criadoEm: l.createdAt,
    atualizadoEm: l.updatedAt,
  }
}

@Injectable()
export class ModelosPropriosService {
  constructor(private readonly prisma: PrismaService) {}

  private async exigirMax(userId: string) {
    const perfil = await this.prisma.profile.findUnique({
      where: { userId },
      select: { plan: true, planStatus: true, currentPeriodEnd: true, graceUntil: true },
    })
    if (!perfil || !canUseContratos(planoVigente(perfil))) {
      throw new ForbiddenException('Criar e editar modelos próprios faz parte do plano Max.')
    }
  }

  private async doDono(userId: string, id: string) {
    const achado = await this.prisma.modeloProprio.findFirst({
      where: { id: String(id ?? ''), userId },
      select: { id: true, revisao: true },
    })
    if (!achado) throw new NotFoundException('Modelo não encontrado.')
    return achado
  }

  async listar(userId: string) {
    const linhas = await this.prisma.modeloProprio.findMany({
      where: { userId },
      select: CAMPOS,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 50,
    })
    return { modelos: linhas.map(paraODono), limite: MODELOS_PROPRIOS_LIMITE }
  }

  async criar(userId: string, body: unknown) {
    await this.exigirMax(userId)
    const conteudo = lerModeloProprio(body)
    const quantos = await this.prisma.modeloProprio.count({ where: { userId } })
    if (quantos >= MODELOS_PROPRIOS_LIMITE) {
      throw new BadRequestException(
        `Você já tem ${MODELOS_PROPRIOS_LIMITE} modelos. Exclua um para criar outro.`,
      )
    }
    const criado = await this.prisma.modeloProprio.create({
      data: { userId, ...conteudo, clausulas: JSON.stringify(conteudo.clausulas) },
      select: CAMPOS,
    })
    return paraODono(criado)
  }

  async atualizar(userId: string, id: string, body: unknown) {
    await this.exigirMax(userId)
    const atual = await this.doDono(userId, id)
    const conteudo = lerModeloProprio(body)
    const salvo = await this.prisma.modeloProprio.update({
      where: { id: atual.id },
      data: { ...conteudo, clausulas: JSON.stringify(conteudo.clausulas), revisao: atual.revisao + 1 },
      select: CAMPOS,
    })
    return paraODono(salvo)
  }

  async excluir(userId: string, id: string) {
    const atual = await this.doDono(userId, id)
    await this.prisma.modeloProprio.delete({ where: { id: atual.id } })
    return { excluido: true as const }
  }
}
