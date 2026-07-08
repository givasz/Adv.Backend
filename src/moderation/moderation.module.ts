import { Module } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { ModerationController } from './moderation.controller'
import { ModerationService } from './moderation.service'

@Module({
  controllers: [ModerationController],
  providers: [ModerationService, PrismaService],
})
export class ModerationModule {}
