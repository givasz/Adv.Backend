import { Module } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { SessionService } from './session.service'
import { criarSessionStore, SESSION_STORE } from './session-store'

// Módulo só para o SessionService: todo controller que atende alguém logado
// precisa dele, e importar um módulo é menos repetição do que repetir os
// providers em cada lugar.
//
// O armazenamento das sessões é escolhido aqui, uma vez, no boot (Postgres por
// padrão; Redis com SESSION_STORE=redis). O serviço nunca sabe qual dos dois é.
@Module({
  providers: [
    SessionService,
    PrismaService,
    {
      provide: SESSION_STORE,
      inject: [PrismaService],
      useFactory: criarSessionStore,
    },
  ],
  exports: [SessionService],
})
export class SessionModule {}
