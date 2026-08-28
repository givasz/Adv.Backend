import { Module } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { BiService } from './bi.service'

@Module({
  providers: [BiService, PrismaService],
  exports: [BiService],
})
export class BiModule {}
