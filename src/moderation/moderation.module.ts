import { Module } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { AdminModule } from '../admin/admin.module'
import { SessionModule } from '../auth/session.module'
import { ModerationController } from './moderation.controller'
import { ModerationService } from './moderation.service'
import { AppealsController } from './appeals.controller'
import { AppealsService } from './appeals.service'

@Module({
  // SessionModule entra porque a contestação é aberta pelo ADVOGADO logado —
  // é a primeira rota deste módulo que autentica alguém que não é admin.
  imports: [AdminModule, SessionModule],
  controllers: [ModerationController, AppealsController],
  providers: [ModerationService, AppealsService, PrismaService],
})
export class ModerationModule {}
