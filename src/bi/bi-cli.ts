// Passagem avulsa da rotina de BI — `npm run bi` no servidor.
//
// O serviço já roda sozinho uma vez por dia (ver bi.service.ts). Este atalho
// existe para o depois-do-deploy: o retrato de hoje é a única coisa do sistema
// que não dá para refazer amanhã, então esperar até a próxima madrugada é um
// risco pequeno que não precisa ser corrido.
//
// Também é o que se roda no primeiro deploy: com a tabela vazia, o fechamento
// mensal recua até o evento mais antigo do banco.

import { NestFactory } from '@nestjs/core'
import { AppModule } from '../app.module'
import { BiService } from './bi.service'

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] })
  try {
    const r = await app.get(BiService).passar()
    console.log(
      `Retrato de hoje: ${r.retratados} perfis. ` +
        `Meses fechados: ${r.meses}. ` +
        `Retratos vencidos apagados: ${r.expurgados}.`,
    )
  } finally {
    await app.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
