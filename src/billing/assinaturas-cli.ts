// Passagem avulsa da varredura de assinaturas — `npm run assinaturas` no servidor.
//
// O serviço já roda sozinho a cada seis horas (ver assinaturas.service.ts). Este
// atalho existe para o depois-do-deploy e para a conferência manual: quando se
// quer ver AGORA quantas assinaturas venceram, sem reiniciar a API só para isso.

import { NestFactory } from '@nestjs/core'
import { AppModule } from '../app.module'
import { AssinaturasService } from './assinaturas.service'

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] })
  try {
    const r = await app.get(AssinaturasService).varrer()
    console.log(
      `Varredura: ${r.rebaixados} assinatura(s) vencida(s) rebaixada(s), ` +
        `${r.agendados} rebaixamento(s) agendado(s) aplicado(s).`,
    )
  } finally {
    await app.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
