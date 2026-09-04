// Passagem avulsa do expurgo — `npm run retencao` no servidor.
//
// O serviço já roda sozinho uma vez por dia (ver retencao.service.ts). Este
// atalho existe para o depois-do-deploy: quando o prazo de guarda muda, ninguém
// quer esperar até a próxima madrugada para ver o efeito, e reiniciar a API só
// para isso é ruído desnecessário em produção.

import { NestFactory } from '@nestjs/core'
import { AppModule } from '../app.module'
import { RetencaoService } from './retencao.service'

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] })
  try {
    const r = await app.get(RetencaoService).expurgar()
    console.log(
      `Expurgo: ${r.eventos} eventos, ${r.auditoria} registros de auditoria, ` +
        `${r.cobranca} eventos de cobrança e ${r.acesso} registros de acesso apagados.`,
    )
  } finally {
    await app.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
