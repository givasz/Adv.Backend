// Seed de desenvolvimento (SQLite). Cria a política vigente + um perfil demo
// (userId 'demo-user-id', usado pelo ProfilesController enquanto não há auth).
// Uso: node prisma/seed.dev.mjs
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  await prisma.policyVersion.upsert({
    where: { version: 'Prov. 205/2021' },
    update: { active: true, rulesetRev: 2 },
    create: {
      version: 'Prov. 205/2021',
      rulesetRev: 2,
      description: 'Provimento 205/2021 do CFOAB — publicidade advocatícia.',
      active: true,
    },
  })

  await prisma.user.upsert({
    where: { email: 'demo@advoc.me' },
    update: {},
    create: {
      id: 'demo-user-id',
      email: 'demo@advoc.me',
      password: 'not-a-real-hash',
      profile: {
        create: {
          slug: 'demo-advogada',
          name: 'Marina Sales',
          oabNumber: 'OAB/SP 123.456',
          oabVerified: true,
          headline: 'Advocacia previdenciária e trabalhista',
          bio: 'Advogada inscrita na OAB/SP, com atuação em Direito Previdenciário e Trabalhista.',
          city: 'São Paulo',
          state: 'SP',
          published: true,
          policyVersion: 'Prov. 205/2021',
          areas: {
            create: [
              { label: 'Direito Previdenciário', description: 'Aposentadorias e benefícios.', order: 0 },
              { label: 'Direito Trabalhista', description: 'Relações de trabalho.', order: 1 },
            ],
          },
        },
      },
    },
  })

  console.log('Seed concluído: PolicyVersion + perfil demo (slug: demo-advogada).')
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
