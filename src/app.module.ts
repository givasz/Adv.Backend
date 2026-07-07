import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { AiModule } from './ai/ai.module'
import { ProfilesModule } from './profiles/profiles.module'

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), AiModule, ProfilesModule],
})
export class AppModule {}
