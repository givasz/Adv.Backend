import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module'
import { assertSecureConfig } from './security/config'
import { securityHeaders } from './security/headers'

// Teto do corpo da requisição. O maior payload legítimo é o perfil com a foto
// embutida (data URI ~300 KB, ver security/sanitize.ts) — 1 MB dá folga sem
// virar upload de arquivo por acidente.
const BODY_LIMIT = '1mb'

async function bootstrap() {
  // Antes de qualquer rota existir: segredo de desenvolvimento em produção é
  // sessão forjável. Aqui o processo morre com a lista do que falta.
  assertSecureConfig()

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: true,
  })
  app.set('json spaces', 0)
  app.disable('x-powered-by')
  // TRUST_PROXY=1 quando houver um proxy à frente (Nginx da VPS, Render): é o que
  // faz req.ip ser o IP real. Sem proxy, confiar no cabeçalho seria deixar
  // qualquer um escolher a própria identidade no rate limit (ver security/net.ts).
  app.set('trust proxy', process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true')
  app.useBodyParser('json', { limit: BODY_LIMIT })
  app.useBodyParser('urlencoded', { limit: BODY_LIMIT, extended: true })
  app.use(securityHeaders)

  app.setGlobalPrefix('api') // combina com o proxy /api do Vite
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }))
  // FRONTEND_ORIGIN aceita uma ou mais origens separadas por vírgula
  // (ex.: "https://advoc.me,https://deploy-preview--advocme.netlify.app").
  const origins = (process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  app.enableCors({
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token'],
    maxAge: 600,
  })
  // 0.0.0.0 + process.env.PORT: exigido por Render e afins.
  await app.listen(process.env.PORT ? Number(process.env.PORT) : 3333, '0.0.0.0')
}
void bootstrap()
