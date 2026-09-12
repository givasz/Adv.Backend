import { Module } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { CorreioModule } from '../mail/correio.module'
import { AdminController } from './admin.controller'
import { AdminService } from './admin.service'
import { LevantamentosService } from './levantamentos.service'

// O painel em um módulo. Exporta o AdminService porque quem guarda as rotas de
// moderação, suporte e busca de perfis precisa dele para duas coisas que não
// podem ser esquecidas numa rota nova: conferir a permissão e registrar a ação.
//
// CorreioModule: suspender, reativar e encerrar uma conta avisam o dono por e-mail.
@Module({
  imports: [CorreioModule],
  controllers: [AdminController],
  providers: [AdminService, LevantamentosService, PrismaService],
  exports: [AdminService],
})
export class AdminModule {}
