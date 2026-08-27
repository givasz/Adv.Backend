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
  ],
  controllers: [HealthController],
})
export class AppModule {}
