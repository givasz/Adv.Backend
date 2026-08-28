import { Module } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { SessionModule } from '../auth/session.module'
import { ProfilesModule } from '../profiles/profiles.module'
import { AccountController } from './account.controller'
import { AccountService } from './account.service'

@Module({
  // Excluir a conta do dono de um escritório devolve o plano dos membros, e plano
  // só se muda pela porta que reconcilia (ProfilesService).
  imports: [SessionModule, ProfilesModule],
  controllers: [AccountController],
  providers: [AccountService, PrismaService],
})
export class AccountModule {}
