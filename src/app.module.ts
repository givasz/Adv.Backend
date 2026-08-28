import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { HealthController } from './health.controller'
import { AiModule } from './ai/ai.module'
import { AdminModule } from './admin/admin.module'
import { AuthModule } from './auth/auth.module'
import { ProfilesModule } from './profiles/profiles.module'
import { ModerationModule } from './moderation/moderation.module'
import { FirmsModule } from './firms/firms.module'
import { SupportModule } from './support/support.module'
import { AccountModule } from './account/account.module'
import { AnalyticsModule } from './analytics/analytics.module'
import { RetencaoModule } from './retencao/retencao.module'
import { BillingModule } from './billing/billing.module'
import { BiModule } from './bi/bi.module'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AiModule,
    AdminModule,
    AuthModule,
    ProfilesModule,
    ModerationModule,
    FirmsModule,
    SupportModule,
    AccountModule,
    AnalyticsModule,
    RetencaoModule,
    BillingModule,
    BiModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
