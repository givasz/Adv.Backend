import { Module } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { SessionModule } from '../auth/session.module'
import { AdminModule } from '../admin/admin.module'
import { CorreioModule } from '../mail/correio.module'
import { ProfilesController } from './profiles.controller'
import { ProfilesService } from './profiles.service'

@Module({
  // CorreioModule: assinar um plano pago pede o e-mail confirmado, e a exigência
  // só vale com o correio ligado — ver ProfilesService.setPlan.
  imports: [SessionModule, AdminModule, CorreioModule],
  controllers: [ProfilesController],
  providers: [ProfilesService, PrismaService],
  // A cobrança (webhook e varredura) e o escritório mudam plano de assinatura, e
  // TÊM de fazer isso pela porta que reconcilia tema, agendamento e endereço —
  // ver ProfilesService.aplicarAssinaturaPorPerfil. Exportar aqui é o que impede
  // um segundo caminho gravando `Profile.plan` cru, que foi como o bug do
  // "saí do escritório e continuei com o tema do Max" nasceu.
  exports: [ProfilesService],
})
export class ProfilesModule {}
