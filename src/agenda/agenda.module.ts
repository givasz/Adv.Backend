import { Module } from '@nestjs/common'
import { SessionModule } from '../auth/session.module'
import { PrismaService } from '../prisma/prisma.service'
import { AgendaController } from './agenda.controller'
import { PublicMeetingController } from './public-meeting.controller'
import { AgendaService } from './agenda.service'

@Module({ imports: [SessionModule], controllers: [AgendaController, PublicMeetingController], providers: [AgendaService, PrismaService] })
export class AgendaModule {}
