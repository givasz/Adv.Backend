import { Module } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { ProfilesModule } from '../profiles/profiles.module'
import { BillingController } from './billing.controller'
import { PagarmeController } from './pagarme.controller'
import { BillingService } from './billing.service'
import { AssinaturasService } from './assinaturas.service'

// Cobrança: a porta de ENTRADA dos eventos do provedor (BillingController) e o
// relógio que aplica o que venceu (AssinaturasService). Os dois gravam pelo mesmo
// caminho do checkout do usuário — ProfilesService.aplicarAssinaturaPorPerfil.
@Module({
  imports: [ProfilesModule],
  controllers: [BillingController, PagarmeController],
  providers: [BillingService, AssinaturasService, PrismaService],
  exports: [BillingService, AssinaturasService],
})
export class BillingModule {}
