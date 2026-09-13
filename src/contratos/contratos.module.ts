import { Module } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { SessionModule } from '../auth/session.module'
import { ContratosController } from './contratos.controller'
import { ContratosService } from './contratos.service'
import { ModelosPropriosService } from './modelos-proprios.service'

@Module({
  imports: [SessionModule],
  controllers: [ContratosController],
  providers: [ContratosService, ModelosPropriosService, PrismaService],
})
export class ContratosModule {}
