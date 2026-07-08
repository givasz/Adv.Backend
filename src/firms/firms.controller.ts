import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common'
import { FirmsService } from './firms.service'

// Autenticação (JWT) omitida neste protótipo — o dono é o mesmo DEMO_USER dos perfis.
const DEMO_USER = 'demo-user-id'

@Controller()
export class FirmsController {
  constructor(private readonly firms: FirmsService) {}

  // GET /api/firms/me  → escritório do dono (para o editor); null se não existe
  @Get('firms/me')
  getMine() {
    return this.firms.getMine(DEMO_USER)
  }

  // PUT /api/firms/me  → cria/atualiza o escritório do dono
  @Put('firms/me')
  saveMine(@Body() body: any) {
    return this.firms.createOrUpdate(DEMO_USER, body)
  }

  // POST /api/firms/me/oab/request → solicita conferência do registro da sociedade
  @Post('firms/me/oab/request')
  requestOab() {
    return this.firms.requestOab(DEMO_USER)
  }

  // GET /api/firms/:slug  (público) — página institucional do escritório
  @Get('firms/:slug')
  getBySlug(@Param('slug') slug: string) {
    return this.firms.getBySlug(slug)
  }
}
