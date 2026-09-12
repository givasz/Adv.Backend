// Avisa por e-mail quem ainda não aceitou a versão vigente dos Termos.
//   npm run correio:termos
//
// Roda à mão, no deploy que troca TERMS_VERSION — depois do `pm2 restart`, para a
// API já estar carimbando a versão nova. Não é automático no boot de propósito:
// trocar os Termos é um ato deliberado, e o aviso em massa é a parte dele que sai
// da plataforma e chega na caixa de todo mundo.
//
// Pode rodar quantas vezes quiser: a chave "termos:<versão>:<conta>" faz o mesmo
// aviso entrar na fila uma vez só. Este comando só ENFILEIRA; quem envia é o
// processo da API, respeitando o teto diário e deixando a reserva do dia para
// quem pediu senha nova (ver RESERVA_DO_DIA em correio.service.ts).

import { NestFactory } from '@nestjs/core'
import { AppModule } from '../app.module'
import { PrismaService } from '../prisma/prisma.service'
import { TERMS_VERSION } from '../legal/termos'
import { CorreioService } from './correio.service'

const LOTE = 500

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] })
  try {
    const correio = app.get(CorreioService)
    if (!correio.ativo) {
      console.error(`O correio está desligado — nada foi enfileirado. ${correio.config.aviso}`)
      process.exitCode = 1
      return
    }
    const prisma = app.get(PrismaService)
    let cursor: string | undefined
    let contas = 0
    let novos = 0
    for (;;) {
      const lote = await prisma.user.findMany({
        // Conta encerrada não tem o que aceitar. Conta sem aceite nenhum (versão
        // vazia) entra: é justamente quem mais precisa do aviso.
        where: { closedAt: null, termsVersion: { not: TERMS_VERSION } },
        select: { id: true, email: true },
        orderBy: { id: 'asc' },
        take: LOTE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })
      if (!lote.length) break
      for (const u of lote) {
        contas++
        const entrou = await correio.enfileirar({
          modelo: 'termos-atualizados',
          para: u.email,
          userId: u.id,
          chave: `termos:${TERMS_VERSION}:${u.id}`,
          dados: { versao: TERMS_VERSION },
        })
        if (entrou) novos++
      }
      cursor = lote[lote.length - 1]!.id
    }
    console.log(
      `Termos ${TERMS_VERSION}: ${contas} conta(s) com aceite pendente; ${novos} aviso(s) novo(s) na fila ` +
        `(os demais já estavam). A API envia aos poucos, dentro do teto diário.`,
    )
  } finally {
    await app.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
