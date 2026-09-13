import { Module } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { CorreioModule } from '../mail/correio.module'
import { SessionModule } from './session.module'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { GoogleController } from './google.controller'

@Module({
  // CorreioModule: confirmação de e-mail, "esqueci minha senha" e o aviso de
  // senha trocada saem daqui.
  imports: [SessionModule, CorreioModule],
  controllers: [AuthController, GoogleController],
  providers: [AuthService, PrismaService],
})
export class AuthModule {}
