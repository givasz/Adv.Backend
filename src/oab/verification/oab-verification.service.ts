// Serviço de conferência de OAB — orquestra o workflow none → pending → verified/rejected
// de forma DESACOPLADA do ProfilesService. Cada transição registra um evento imutável
// (OabVerificationEvent) com data, método, responsável e motivo, e atualiza o snapshot
// no Profile. A estratégia de conferência é plugável (ver oab-verifier.ts).

import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type { OabStatus } from '@prisma/client'
import { PrismaService } from '../../prisma/prisma.service'
import { POLICY_VERSION } from '../compliance'
import { resolveOabVerifier, type OabVerifier } from './oab-verifier'

export type OabDecision = 'verify' | 'reject'

@Injectable()
export class OabVerificationService {
  private readonly verifier: OabVerifier = resolveOabVerifier()

  constructor(private readonly prisma: PrismaService) {}

  /** Advogado solicita a conferência do próprio número (não concede a marca).
   *  Recurso EXCLUSIVO dos planos pagos — no Free não há conferência de OAB. */
  async request(userId: string) {
    const profile = await this.prisma.profile.findUnique({
      where: { userId },
      select: { id: true, oabStatus: true, plan: true, oabNumber: true, name: true, state: true },
    })
    if (!profile) throw new NotFoundException('Perfil não encontrado')
    if (profile.plan === 'free') {
      throw new ForbiddenException('A conferência de OAB está disponível apenas nos planos pagos.')
    }
    if (profile.oabStatus === 'verified') return { oabStatus: 'verified' as const }

    // Consulta a estratégia ativa. No fluxo manual, apenas coloca em análise.
    const check = await this.verifier.check({
      oabNumber: profile.oabNumber,
      name: profile.name,
      state: profile.state,
    })

    // Verificador automático (futuro) pode decidir na hora; o manual pede revisão.
    if (check.outcome === 'verified' || check.outcome === 'rejected') {
      return this.applyDecision(
        profile.id,
        profile.oabStatus,
        check.outcome === 'verified' ? 'verify' : 'reject',
        { reviewer: `auto:${check.method}`, reason: check.reason, method: check.method },
      )
    }

    return this.transition(profile.id, profile.oabStatus, 'pending', {
      method: check.method,
      reviewer: '', // solicitação do próprio advogado
      reason: '',
      action: 'oab:request',
    })
  }

  /** Fila de conferências pendentes (uso do admin). */
  listPending() {
    return this.prisma.profile.findMany({
      where: { oabStatus: 'pending' },
      orderBy: { updatedAt: 'asc' },
      select: {
        id: true,
        name: true,
        oabNumber: true,
        city: true,
        state: true,
        slug: true,
        updatedAt: true,
      },
    })
  }

  /** Decisão do admin: aprova (marca "OAB conferida") ou rejeita, com auditoria. */
  async decide(profileId: string, decision: OabDecision, reviewer: string, reason?: string) {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { oabStatus: true },
    })
    if (!profile) throw new NotFoundException('Perfil não encontrado')
    return this.applyDecision(profileId, profile.oabStatus, decision, {
      reviewer,
      reason,
      method: 'manual',
    })
  }

  /** Histórico completo de conferência de um perfil (mais recente primeiro). */
  history(profileId: string) {
    return this.prisma.oabVerificationEvent.findMany({
      where: { profileId },
      orderBy: { createdAt: 'desc' },
    })
  }

  // ---- internos ----------------------------------------------------------

  private async applyDecision(
    profileId: string,
    fromStatus: OabStatus,
    decision: OabDecision,
    meta: { reviewer: string; reason?: string; method: string },
  ) {
    const verified = decision === 'verify'
    const toStatus: OabStatus = verified ? 'verified' : 'rejected'
    return this.transition(profileId, fromStatus, toStatus, {
      method: meta.method,
      reviewer: meta.reviewer,
      reason: meta.reason ?? '',
      action: verified ? 'oab:verified' : 'oab:rejected',
      snapshot: verified,
    })
  }

  /**
   * Executa a transição de estado: atualiza o snapshot do Profile, grava o evento
   * imutável de histórico e a trilha de auditoria (AuditLog) numa única transação.
   */
  private async transition(
    profileId: string,
    fromStatus: OabStatus,
    toStatus: OabStatus,
    meta: { method: string; reviewer: string; reason: string; action: string; snapshot?: boolean },
  ) {
    const verified = toStatus === 'verified'
    const now = new Date()

    const [updated] = await this.prisma.$transaction([
      this.prisma.profile.update({
        where: { id: profileId },
        data: {
          oabStatus: toStatus,
          oabVerified: verified,
          // Snapshot da conferência só quando aprovado; limpo em rejeição/pending.
          oabVerifiedAt: meta.snapshot && verified ? now : verified ? now : null,
          oabVerifiedMethod: verified ? meta.method : null,
          oabVerifiedBy: verified ? meta.reviewer : null,
        },
        select: { oabStatus: true, oabVerified: true, oabVerifiedAt: true },
      }),
      this.prisma.oabVerificationEvent.create({
        data: {
          profileId,
          fromStatus,
          toStatus,
          method: meta.method,
          reviewer: meta.reviewer,
          reason: meta.reason,
        },
      }),
      this.prisma.auditLog.create({
        data: {
          profileId,
          action: meta.action,
          complianceStatus: 'ok',
          policyVersion: POLICY_VERSION,
          bioSnapshot: meta.reason, // reaproveita a coluna para a observação
        },
      }),
    ])

    return updated
  }
}
