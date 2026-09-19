import { Body, Controller, Headers, Ip, Param, Post } from '@nestjs/common'
import { clientIp } from '../security/net'
import { enforceRateLimit } from '../security/rate-limit'
import { AgendaService } from './agenda.service'

@Controller('profiles')
export class PublicMeetingController {
  constructor(private readonly agenda: AgendaService) {}

  @Post(':slug/meeting-requests')
  request(@Param('slug') slug: string, @Body() body: any, @Ip() ip?: string, @Headers('x-forwarded-for') forwardedFor?: string) {
    const key = clientIp(ip, forwardedFor)
    enforceRateLimit([[`meeting:${key}`, { windowMs: 900_000, max: 5 }], [`meeting:${slug}`, { windowMs: 3_600_000, max: 60 }]])
    return this.agenda.solicitar(slug, body)
  }
}
