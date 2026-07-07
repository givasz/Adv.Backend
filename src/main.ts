import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  app.setGlobalPrefix('api') // combina com o proxy /api do Vite
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }))
  // FRONTEND_ORIGIN aceita uma ou mais origens separadas por vírgula
  // (ex.: "https://advoc.me,https://deploy-preview--advocme.netlify.app").
  const origins = (process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  app.enableCors({ origin: origins, credentials: true })
  // 0.0.0.0 + process.env.PORT: exigido por Render e afins.
  await app.listen(process.env.PORT ? Number(process.env.PORT) : 3333, '0.0.0.0')
}
void bootstrap()
