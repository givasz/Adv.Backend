import { Module } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { FirmsController } from './firms.controller'
import { FirmsService } from './firms.service'

@Module({
  controllers: [FirmsController],
  providers: [FirmsService, PrismaService],
})
export class FirmsModule {}
