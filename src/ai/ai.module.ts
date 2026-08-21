import { Module } from '@nestjs/common'
import { SessionModule } from '../auth/session.module'
import { AiController } from './ai.controller'
import { AiService } from './ai.service'
import { PrismaService } from '../prisma/prisma.service'

@Module({
  imports: [SessionModule],
  controllers: [AiController],
  providers: [AiService, PrismaService],
})
export class AiModule {}
