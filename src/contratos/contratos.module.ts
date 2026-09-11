import { Module } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { SessionModule } from '../auth/session.module'
import { ContratosController } from './contratos.controller'
import { ContratosService } from './contratos.service'

@Module({
  imports: [SessionModule],
  controllers: [ContratosController],
  providers: [ContratosService, PrismaService],
})
export class ContratosModule {}
