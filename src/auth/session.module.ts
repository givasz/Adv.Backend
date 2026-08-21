import { Module } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { SessionService } from './session.service'

// Módulo só para o SessionService: todo controller que atende alguém logado
// precisa dele, e importar um módulo é menos repetição do que repetir os
// providers em cada lugar.
@Module({
  providers: [SessionService, PrismaService],
  exports: [SessionService],
})
export class SessionModule {}
