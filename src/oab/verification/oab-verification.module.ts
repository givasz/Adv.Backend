import { Module } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { OabVerificationService } from './oab-verification.service'

// Módulo desacoplado da conferência de OAB. Exporta o serviço para quem precisar
// (hoje o ProfilesController). Mantém o workflow de verificação isolado do CRUD de perfil.
@Module({
  providers: [OabVerificationService, PrismaService],
  exports: [OabVerificationService],
})
export class OabVerificationModule {}
