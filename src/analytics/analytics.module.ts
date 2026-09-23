import { Module } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { SessionModule } from '../auth/session.module'
import { FirmsModule } from '../firms/firms.module'
import { AnalyticsController } from './analytics.controller'
import { AnalyticsService } from './analytics.service'

@Module({
  // FirmsModule: o resumo da página institucional confere o papel de quem pede
  // pela mesma função que o editor do escritório usa.
  imports: [SessionModule, FirmsModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, PrismaService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
