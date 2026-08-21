import { Module } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { SessionModule } from '../auth/session.module'
import { FirmsController } from './firms.controller'
import { FirmsService } from './firms.service'

@Module({
  imports: [SessionModule],
  controllers: [FirmsController],
  providers: [FirmsService, PrismaService],
})
export class FirmsModule {}
