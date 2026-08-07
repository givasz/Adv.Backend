import { Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger(PrismaService.name)

  async onModuleInit() {
    // Boot resiliente: se o banco estiver fora (ex.: Postgres free do Render
    // expirou), a API ainda sobe para servir /ai/generate (que não usa banco).
    // As rotas que dependem do banco falham sob demanda; o Prisma reconecta na
    // próxima query quando o banco voltar.
    try {
      await this.$connect()
    } catch (err) {
      this.logger.warn(`Banco indisponível no boot — API subindo mesmo assim. ${(err as Error).message}`)
    }
  }
}
