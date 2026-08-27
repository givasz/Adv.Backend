import { Module } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { SessionModule } from '../auth/session.module'
import { AnalyticsController } from './analytics.controller'
import { AnalyticsService } from './analytics.service'

@Module({
  imports: [SessionModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, PrismaService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
