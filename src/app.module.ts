import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
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
})
export class AppModule {}
