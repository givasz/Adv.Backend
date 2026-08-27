import { Module } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { RetencaoService } from './retencao.service'

@Module({
  providers: [RetencaoService, PrismaService],
  exports: [RetencaoService],
})
export class RetencaoModule {}
