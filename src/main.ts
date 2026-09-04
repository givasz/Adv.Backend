import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module'
import { assertSecureConfig } from './security/config'
import { avisarSobreTreinoDeIa, descreverCadeia } from './ai/provedores'
import { securityHeaders } from './security/headers'
import { sessionContext } from './auth/session-context'
import { CSRF_HEADER, origemPermitida } from './auth/csrf'

// Teto do corpo da requisição. O maior payload legítimo é o perfil com a foto
// embutida (data URI ~300 KB, ver security/sanitize.ts) — 1 MB dá folga sem
// virar upload de arquivo por acidente.
const BODY_LIMIT = '1mb'

async function bootstrap() {
  // Antes de qualquer rota existir: segredo de desenvolvimento em produção é
  // sessão forjável. Aqui o processo morre com a lista do que falta.
  assertSecureConfig()
  // E aqui só reclama: a cadeia de IA configurada sustenta o que /legal/ia
  // promete sobre treinamento? O que sai daqui leva nome, cidade e o texto do
  // advogado. Ver ai/provedores.ts.
  avisarSobreTreinoDeIa()
  // E o que a cadeia tem DE VERDADE: nomes no .env não são chaves. Esta linha
  // é a primeira coisa a conferir depois de um `pm2 restart`.
  console.log(`[ia] ${descreverCadeia(process.env)}`)

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: true,
  })
  app.set('json spaces', 0)
  app.disable('x-powered-by')
  // TRUST_PROXY=1 quando houver um proxy à frente (Nginx da VPS, Render): é o que
  // faz req.ip ser o IP real. Sem proxy, confiar no cabeçalho seria deixar
  // qualquer um escolher a própria identidade no rate limit (ver security/net.ts).
  app.set('trust proxy', process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true')
  // O corpo CRU é preservado para o webhook de cobrança conferir a assinatura
  // HMAC. Tem de ser o byte a byte recebido: `JSON.stringify(JSON.parse(x))` não
  // devolve `x` (ordem de chaves, espaços, escapes), e uma diferença de um byte
  // invalida o HMAC — é o erro clássico de integração de webhook.
  //
  // Guardado só na rota do webhook: manter uma cópia do corpo de TODA requisição
  // dobraria a memória por pedido para servir a uma rota só.
  app.useBodyParser('json', {
    limit: BODY_LIMIT,
    verify: (req: { url?: string; rawBody?: Buffer }, _res: unknown, buf: Buffer) => {
      if (req.url?.startsWith('/api/billing/')) req.rawBody = Buffer.from(buf)
    },
  })
  app.useBodyParser('urlencoded', { limit: BODY_LIMIT, extended: true })
  app.use(securityHeaders)
  // Monta o contexto de autenticação (cookie da sessão, origem, token anti-CSRF)
  // em toda requisição. Só lê cabeçalhos — a sessão em si só é validada quando
  // uma rota pergunta quem é o dono. Ver auth/session-context.ts.
  app.use(sessionContext)

  app.setGlobalPrefix('api') // combina com o proxy /api do Vite
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }))
  // FRONTEND_ORIGIN aceita uma ou mais origens separadas por vírgula
  // (ex.: "https://advoc.me,https://deploy-preview--advocme.netlify.app").
  // A MESMA lista é conferida no anti-CSRF (auth/csrf.ts) — uma origem só entra
  // aqui se também puder mandar pedidos que escrevem.
  //
  // `credentials: true` é o que permite ao navegador anexar o cookie de sessão
  // numa chamada de outro site (o front no Netlify, a API na VPS). Com ele, a
  // lista de origens deixa de ser conforto e passa a ser a fronteira: um `*`
  // aqui entregaria a sessão de quem está logado a qualquer página da internet.
  app.enableCors({
    // A MESMA função do anti-CSRF decide — uma lista e uma regra só. Enquanto
    // eram dois lugares, o CORS liberava e o CSRF barrava (ou o contrário), e o
    // sintoma era um app que carregava mas não salvava.
    origin: (origem: string | undefined, cb: (erro: Error | null, ok?: boolean) => void) =>
      cb(null, origemPermitida(origem)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    // Sem `Authorization`: nenhuma rota lê esse cabeçalho desde que a sessão do
    // advogado e a do painel viraram cookie. Anunciar o que não é aceito só
    // convida alguém a tentar autenticar por ali.
    allowedHeaders: ['Content-Type', 'x-admin-token', CSRF_HEADER],
    maxAge: 600,
  })
  // 0.0.0.0 + process.env.PORT: exigido por Render e afins.
  await app.listen(process.env.PORT ? Number(process.env.PORT) : 3333, '0.0.0.0')
}
void bootstrap()
