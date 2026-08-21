import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Put,
  UnauthorizedException,
} from '@nestjs/common'
import { FirmsService } from './firms.service'
import { userIdFromHeader } from '../auth/user-auth'

@Controller()
export class FirmsController {
  constructor(private readonly firms: FirmsService) {}

  // O escritório é sempre de alguém: diferente do perfil individual (que tem um
  // rascunho anônimo no Free), aqui não existe dono demo. Sem sessão válida, 401 —
  // senão qualquer visitante editaria o escritório do vizinho.
  private resolveOwner(authorization?: string): string {
    const userId = userIdFromHeader(authorization)
    if (!userId) throw new UnauthorizedException('Entre na sua conta para gerenciar o escritório')
    return userId
  }

  // GET /api/firms/me  → escritório do dono (para o editor); null se não existe
  @Get('firms/me')
  getMine(@Headers('authorization') authorization?: string) {
    return this.firms.getMine(this.resolveOwner(authorization))
  }

  // PUT /api/firms/me  → cria/atualiza o escritório do dono
  @Put('firms/me')
  saveMine(@Body() body: any, @Headers('authorization') authorization?: string) {
    return this.firms.createOrUpdate(this.resolveOwner(authorization), body)
  }

  // POST /api/firms/me/oab/request → solicita conferência do registro da sociedade
  @Post('firms/me/oab/request')
  requestOab(@Headers('authorization') authorization?: string) {
    return this.firms.requestOab(this.resolveOwner(authorization))
  }

  // GET /api/firms/:slug  (público) — página institucional do escritório
  @Get('firms/:slug')
  getBySlug(@Param('slug') slug: string) {
    return this.firms.getBySlug(slug)
  }
}
