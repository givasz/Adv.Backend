import { Module } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { ProfilesModule } from '../profiles/profiles.module'
import { SessionModule } from '../auth/session.module'
import { CorreioModule } from '../mail/correio.module'
import { BillingController } from './billing.controller'
import { AsaasController } from './asaas.controller'
import { CheckoutController } from './checkout.controller'
import { BillingService } from './billing.service'
import { AssinaturasService } from './assinaturas.service'
import { CheckoutService } from './checkout.service'
import { AsaasApi } from './asaas.api'

// Cobrança, em três partes:
//
//   • ENTRADA — o que o provedor nos conta (BillingController, AsaasController);
//   • SAÍDA — o checkout do advogado, que cria a assinatura no Asaas
//     (CheckoutController → CheckoutService → AsaasApi);
//   • RELÓGIO — o que venceu desde ontem (AssinaturasService).
//
// As três gravam plano pelo mesmo caminho: ProfilesService.aplicarAssinaturaPorPerfil.
// CorreioModule: assinar pede o e-mail confirmado quando o correio está ligado.
@Module({
  imports: [ProfilesModule, SessionModule, CorreioModule],
  controllers: [BillingController, AsaasController, CheckoutController],
  providers: [BillingService, AssinaturasService, CheckoutService, AsaasApi, PrismaService],
  exports: [BillingService, AssinaturasService],
})
export class BillingModule {}
