import { Module } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { SessionModule } from '../auth/session.module'
import { ProfilesModule } from '../profiles/profiles.module'
import { FirmsController } from './firms.controller'
import { FirmsService } from './firms.service'

@Module({
  // Entrar e sair do escritório muda plano, e plano só se muda pela porta que
  // reconcilia (ProfilesService.aplicarAssinaturaPorPerfil).
  imports: [SessionModule, ProfilesModule],
  controllers: [FirmsController],
  providers: [FirmsService, PrismaService],
})
export class FirmsModule {}
