import { Module } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { SessionModule } from '../auth/session.module'
import { AdminModule } from '../admin/admin.module'
import { CorreioModule } from '../mail/correio.module'
import { SupportController } from './support.controller'
import { SupportService } from './support.service'

@Module({
  imports: [SessionModule, AdminModule, CorreioModule],
  controllers: [SupportController],
  providers: [SupportService, PrismaService],
})
export class SupportModule {}
