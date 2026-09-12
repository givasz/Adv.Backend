import { Module } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { CorreioService } from './correio.service'

// Um correio só para a aplicação inteira. Quem avisa alguém (autenticação,
// moderação, painel) importa este módulo — e todos recebem a MESMA instância,
// com o mesmo despachante e a mesma espera do provedor. Um CorreioService por
// módulo seriam três despachantes disputando a fila e três contas de "quantos
// saíram hoje".
@Module({
  providers: [CorreioService, PrismaService],
  exports: [CorreioService],
})
export class CorreioModule {}
