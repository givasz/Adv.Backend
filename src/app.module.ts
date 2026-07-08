import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { AiModule } from './ai/ai.module'
import { ProfilesModule } from './profiles/profiles.module'
import { ModerationModule } from './moderation/moderation.module'
import { FirmsModule } from './firms/firms.module'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AiModule,
    ProfilesModule,
    ModerationModule,
    FirmsModule,
  ],
})
export class AppModule {}
