import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common'
import { BookingsService, type CreateBookingDto } from './bookings.service'
import { userIdFromHeader } from '../auth/user-auth'

// Dono anônimo do protótipo; quando há sessão (Bearer), usamos o dono real.
const DEMO_USER = 'demo-user-id'

@Controller()
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  private resolveUser(authorization?: string): string {
    return userIdFromHeader(authorization) ?? DEMO_USER
  }

  // GET /api/profiles/:slug/availability  (público)
  @Get('profiles/:slug/availability')
  availability(@Param('slug') slug: string) {
    return this.bookings.availability(slug)
  }

  // POST /api/profiles/:slug/bookings  (público — cliente marca)
  @Post('profiles/:slug/bookings')
  create(@Param('slug') slug: string, @Body() body: CreateBookingDto) {
    return this.bookings.create(slug, body)
  }

  // GET /api/profiles/me/bookings  (dono)
  @Get('profiles/me/bookings')
  listMine(@Query('status') _status?: string, @Headers('authorization') authorization?: string) {
    return this.bookings.listMine(this.resolveUser(authorization))
  }

  // POST /api/profiles/me/bookings/:id/decision  → { decision: 'confirm'|'decline'|'cancel' }
  @Post('profiles/me/bookings/:id/decision')
  decide(
    @Param('id') id: string,
    @Body() body: { decision: 'confirm' | 'decline' | 'cancel' },
    @Headers('authorization') authorization?: string,
  ) {
    return this.bookings.decide(this.resolveUser(authorization), id, body.decision)
  }
}
