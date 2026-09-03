// `npm run admin:create` — cria (ou conserta) um administrador do painel.
//
// Existe para tirar a credencial do .env do caminho. Enquanto a tabela AdminUser
// está vazia, o usuário/senha do ambiente ainda entram — é a porta pela qual o
// primeiro administrador nasce. Criado o primeiro, ela fecha sozinha.
//
// Mora em `src/` (e não em `scripts/`) de propósito: assim ele usa o MESMO
// `hashPassword` do resto da aplicação. Um script solto teria que reimplementar
// o formato do hash, e duas implementações de uma função de senha é uma a mais
// do que se pode auditar.
//
// Uso, depois de `npm run build`:
//
//   node dist/admin/admin-cli.js --email ana@escritorio.com --name "Ana" --role owner
//   node dist/admin/admin-cli.js --email ana@… --role owner --password "..."   (senha própria)
//   node dist/admin/admin-cli.js --list
//   node dist/admin/admin-cli.js --email ana@… --reset                          (nova senha)
//
// Sem `--password`, uma senha forte é sorteada e impressa uma única vez.

import { randomBytes } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { hashPassword } from '../auth/user-auth'
import { ADMIN_ROLES, ROLE_DESCRICAO, isAdminRole } from './admin-roles'

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(`--${nome}`)
  if (i < 0) return undefined
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : ''
}
const tem = (nome: string) => process.argv.includes(`--${nome}`)

function senhaSorteada(): string {
  // 24 bytes em base64url ≈ 32 caracteres: forte o bastante para ser digitada
  // uma vez e trocada depois, e curta o bastante para caber num aviso.
  return randomBytes(24).toString('base64url')
}

function ajuda(): void {
  console.log(`
Administradores do painel advoc.me

  --list                       lista quem administra hoje
  --email <e-mail>             conta a criar ou consertar
  --name  <nome>               nome que aparece no histórico
  --role  <papel>              ${ADMIN_ROLES.join(' | ')}   (padrão: owner no primeiro, support depois)
  --password <senha>           senha própria; sem isto, uma é sorteada
  --reset                      só troca a senha de uma conta que já existe
  --activate / --deactivate    liga ou desliga o acesso

Papéis:
${ADMIN_ROLES.map((r) => `  ${r.padEnd(10)} ${ROLE_DESCRICAO[r]}`).join('\n')}
`)
}

async function main(): Promise<number> {
  if (tem('help') || process.argv.length <= 2) {
    ajuda()
    return 0
  }

  const prisma = new PrismaClient()
  try {
    if (tem('list')) {
      const todos = await prisma.adminUser.findMany({ orderBy: { createdAt: 'asc' } })
      if (!todos.length) {
        console.log('Nenhum administrador cadastrado — a credencial do .env ainda entra.')
        return 0
      }
      for (const a of todos) {
        const marca = a.active ? ' ' : '×'
        const fator = a.totpEnabled ? '2FA' : '   '
        console.log(`${marca} ${fator}  ${String(a.role).padEnd(10)} ${a.email}  (${a.name})`)
      }
      return 0
    }

    const email = (arg('email') ?? '').trim().toLowerCase()
    if (!email) {
      console.error('Falta --email. Use --help para ver as opções.')
      return 1
    }

    const existente = await prisma.adminUser.findUnique({ where: { email } })

    // Ligar/desligar acesso, sem tocar em mais nada.
    if (tem('activate') || tem('deactivate')) {
      if (!existente) {
        console.error(`Não há administrador com o e-mail ${email}.`)
        return 1
      }
      const active = tem('activate')
      await prisma.adminUser.update({ where: { email }, data: { active } })
      if (!active) await prisma.adminSession.deleteMany({ where: { adminId: existente.id } })
      console.log(`${email}: acesso ${active ? 'reativado' : 'desligado'}.`)
      return 0
    }

    const senha = arg('password') || senhaSorteada()
    const sorteada = !arg('password')
    if (senha.length < 12) {
      console.error('A senha do painel precisa de ao menos 12 caracteres.')
      return 1
    }

    if (existente) {
      if (!tem('reset') && !arg('role') && !arg('name')) {
        console.error(
          `Já existe administrador com ${email}. Use --reset para trocar a senha, ` +
            'ou --role/--name para corrigir os dados.',
        )
        return 1
      }
      const papel = arg('role')
      if (papel && !isAdminRole(papel)) {
        console.error(`Papel inválido. Use: ${ADMIN_ROLES.join(', ')}`)
        return 1
      }
      await prisma.adminUser.update({
        where: { email },
        data: {
          ...(tem('reset') ? { passwordHash: await hashPassword(senha) } : {}),
          ...(papel ? { role: papel as never } : {}),
          ...(arg('name') ? { name: (arg('name') as string).trim() } : {}),
        },
      })
      if (tem('reset')) {
        // Trocar a senha sem derrubar as sessões abertas seria trocá-la só no papel.
        await prisma.adminSession.deleteMany({ where: { adminId: existente.id } })
        console.log(`Senha trocada e sessões encerradas.\n\n  usuário: ${email}`)
        if (sorteada) console.log(`  senha:   ${senha}\n\n(Anote agora: ela não é mostrada de novo.)`)
      } else {
        console.log(`${email}: dados atualizados.`)
      }
      return 0
    }

    const quantos = await prisma.adminUser.count()
    const papelPedido = arg('role')
    if (papelPedido && !isAdminRole(papelPedido)) {
      console.error(`Papel inválido. Use: ${ADMIN_ROLES.join(', ')}`)
      return 1
    }
    // O primeiro administrador nasce responsável — senão ninguém poderia criar
    // o segundo, e o painel ficaria trancado com a porta de emergência fechada.
    const papel = papelPedido ?? (quantos === 0 ? 'owner' : 'support')
    const nome = (arg('name') ?? '').trim() || email.split('@')[0]!

    await prisma.adminUser.create({
      data: { email, name: nome, role: papel as never, passwordHash: await hashPassword(senha) },
    })

    console.log(`\nAdministrador criado.\n\n  usuário: ${email}\n  papel:   ${papel}`)
    if (sorteada) console.log(`  senha:   ${senha}\n\n(Anote agora: ela não é mostrada de novo.)`)
    if (quantos === 0) {
      console.log(
        '\nA credencial de emergência do .env (ADMIN_USERNAME/ADMIN_PASSWORD) acabou de\n' +
          'parar de valer. O acesso ao painel agora é só por esta conta.',
      )
    }
    if (papel === 'owner' || papel === 'moderator') {
      console.log('\nNo primeiro acesso o painel vai pedir o segundo fator (código de 6 dígitos).')
    }
    return 0
  } finally {
    await prisma.$disconnect()
  }
}

main()
  .then((codigo) => process.exit(codigo))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
