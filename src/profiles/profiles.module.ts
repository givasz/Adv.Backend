import { Module } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { ProfilesController } from './profiles.controller'
import { ProfilesService } from './profiles.service'
import { OabVerificationModule } from '../oab/verification/oab-verification.module'

@Module({
  imports: [OabVerificationModule],
  controllers: [ProfilesController],
  providers: [ProfilesService, PrismaService],
})
export class ProfilesModule {}
