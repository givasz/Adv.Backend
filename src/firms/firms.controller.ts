import { Controller, Get, Param } from '@nestjs/common'
import { FirmsService } from './firms.service'

@Controller()
export class FirmsController {
  constructor(private readonly firms: FirmsService) {}

  // GET /api/firms/:slug  (público) — página institucional do escritório
  @Get('firms/:slug')
  getBySlug(@Param('slug') slug: string) {
    return this.firms.getBySlug(slug)
  }
}
