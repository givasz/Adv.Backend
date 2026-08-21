import {
  Body,
  Controller,
  Delete,
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
  private resolveUser(authorization?: string): string {
    const userId = userIdFromHeader(authorization)
    if (!userId) throw new UnauthorizedException('Entre na sua conta para gerenciar o escritório')
    return userId
  }

  // GET /api/firms/me  → escritório que o usuário administra (para o editor); null se não existe
  @Get('firms/me')
  getMine(@Headers('authorization') authorization?: string) {
    return this.firms.getMine(this.resolveUser(authorization))
  }

  // PUT /api/firms/me  → cria/atualiza os dados INSTITUCIONAIS do escritório.
  // A lista de advogados NÃO vem por aqui: membro entra por convite (POST members).
  @Put('firms/me')
  saveMine(@Body() body: any, @Headers('authorization') authorization?: string) {
    return this.firms.createOrUpdate(this.resolveUser(authorization), body)
  }

  // POST /api/firms/me/members  → { email, role? } convida um advogado
  @Post('firms/me/members')
  invite(
    @Body() body: { email?: string; role?: string },
    @Headers('authorization') authorization?: string,
  ) {
    return this.firms.invite(this.resolveUser(authorization), body?.email, body?.role)
  }

  // DELETE /api/firms/me/members/:kind/:id  → desfaz o vínculo (membership) ou
  // cancela o convite por e-mail (invite). O perfil da pessoa nunca é apagado.
  @Delete('firms/me/members/:kind/:id')
  removeMember(
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Headers('authorization') authorization?: string,
  ) {
    return this.firms.removeMember(this.resolveUser(authorization), kind, id)
  }

  // POST /api/firms/me/oab/request → solicita conferência do registro da sociedade
  @Post('firms/me/oab/request')
  requestOab(@Headers('authorization') authorization?: string) {
    return this.firms.requestOab(this.resolveUser(authorization))
  }

  // ---- Lado de quem foi convidado -------------------------------------------

  // GET /api/firms/me/invites → convites pendentes dirigidos a quem está logado
  @Get('firms/me/invites')
  myInvites(@Headers('authorization') authorization?: string) {
    return this.firms.myInvites(this.resolveUser(authorization))
  }

  // POST /api/firms/me/invites/:id/accept
  @Post('firms/me/invites/:id/accept')
  accept(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    return this.firms.acceptInvite(this.resolveUser(authorization), id)
  }

  // POST /api/firms/me/invites/:id/decline
  @Post('firms/me/invites/:id/decline')
  decline(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    return this.firms.declineInvite(this.resolveUser(authorization), id)
  }

  // POST /api/firms/me/leave → o advogado sai do escritório por vontade própria
  @Post('firms/me/leave')
  leave(@Headers('authorization') authorization?: string) {
    return this.firms.leave(this.resolveUser(authorization))
  }

  // GET /api/firms/:slug  (público) — página institucional do escritório
  // Depois das rotas /firms/me/*, senão o Nest casaria "me" como slug.
  @Get('firms/:slug')
  getBySlug(@Param('slug') slug: string) {
    return this.firms.getBySlug(slug)
  }
}
