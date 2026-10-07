import { Module } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { ProfilesModule } from '../profiles/profiles.module'
import { SessionModule } from '../auth/session.module'
import { AdminModule } from '../admin/admin.module'
import { CorreioModule } from '../mail/correio.module'
import { PartnersController } from './partners.controller'
import { PartnersAdminController } from './partners-admin.controller'
import { PartnersService } from './partners.service'
import { PartnerMaintenanceService } from './partner-maintenance.service'
import { AsaasApi } from '../billing/asaas.api'
import { BillingLockService } from '../billing/billing-lock'

// Programa Advocme Parceiros.
//
// Exporta o serviço para a COBRANÇA: o webhook e o checkout confirmam pagamento e
// chamam o mesmo método idempotente (registrarConversao). O caminho contrário não
// existe — este módulo não importa a cobrança, e não toca em plano: quem
// reconcilia o perfil é ProfilesService.reconciliarPlanoEfetivo.
//
// AsaasApi e BillingLockService entram como PROVIDERS (classes sem estado), e não
// pelo BillingModule: o aceite encerra a renovação de quem já paga, e importar o
// módulo da cobrança aqui fecharia um ciclo (a cobrança importa este módulo).
@Module({
  imports: [ProfilesModule, SessionModule, AdminModule, CorreioModule],
  controllers: [PartnersController, PartnersAdminController],
  providers: [PartnersService, PartnerMaintenanceService, PrismaService, AsaasApi, BillingLockService],
  exports: [PartnersService],
})
export class PartnersModule {}
