import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { HealthController } from './health.controller'
import { AiModule } from './ai/ai.module'
import { AuthModule } from './auth/auth.module'
import { ProfilesModule } from './profiles/profiles.module'
import { ModerationModule } from './moderation/moderation.module'
import { FirmsModule } from './firms/firms.module'
import { BookingsModule } from './bookings/bookings.module'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AiModule,
    AuthModule,
    ProfilesModule,
    ModerationModule,
    FirmsModule,
    BookingsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
