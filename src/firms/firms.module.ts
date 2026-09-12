import { Module } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { SessionModule } from '../auth/session.module'
import { ProfilesModule } from '../profiles/profiles.module'
import { CorreioModule } from '../mail/correio.module'
import { FirmsController } from './firms.controller'
import { FirmsService } from './firms.service'

@Module({
  // Entrar e sair do escritório muda plano, e plano só se muda pela porta que
  // reconcilia (ProfilesService.aplicarAssinaturaPorPerfil).
  // CorreioModule: o convite chega por e-mail a quem foi convidado.
  imports: [SessionModule, ProfilesModule, CorreioModule],
  controllers: [FirmsController],
  providers: [FirmsService, PrismaService],
})
export class FirmsModule {}
