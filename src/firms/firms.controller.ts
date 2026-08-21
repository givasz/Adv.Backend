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
import { SessionService } from '../auth/session.service'

@Controller()
export class FirmsController {
  constructor(
    private readonly firms: FirmsService,
    private readonly sessions: SessionService,
  ) {}

  // O escritório é sempre de alguém: diferente do perfil individual (que tem um
  // rascunho anônimo no Free), aqui não existe dono demo. Sem sessão válida, 401 —
  // senão qualquer visitante editaria o escritório do vizinho.
  private resolveUser(authorization?: string): Promise<string> {
    return this.sessions.requireUser(
      authorization,
      'Entre na sua conta para gerenciar o escritório',
    )
  }

  // GET /api/firms/me  → escritório que o usuário administra (para o editor); null se não existe
  @Get('firms/me')
  async getMine(@Headers('authorization') authorization?: string) {
    return this.firms.getMine(await this.resolveUser(authorization))
  }

  // PUT /api/firms/me  → cria/atualiza os dados INSTITUCIONAIS do escritório.
  // A lista de advogados NÃO vem por aqui: membro entra por convite (POST members).
  @Put('firms/me')
  async saveMine(@Body() body: any, @Headers('authorization') authorization?: string) {
    return this.firms.createOrUpdate(await this.resolveUser(authorization), body)
  }

  // POST /api/firms/me/members  → { email, role? } convida um advogado
  @Post('firms/me/members')
  async invite(
    @Body() body: { email?: string; role?: string },
    @Headers('authorization') authorization?: string,
  ) {
    return this.firms.invite(await this.resolveUser(authorization), body?.email, body?.role)
  }

  // DELETE /api/firms/me/members/:kind/:id  → desfaz o vínculo (membership) ou
  // cancela o convite por e-mail (invite). O perfil da pessoa nunca é apagado.
  @Delete('firms/me/members/:kind/:id')
  async removeMember(
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Headers('authorization') authorization?: string,
  ) {
    return this.firms.removeMember(await this.resolveUser(authorization), kind, id)
  }

  // ---- Lado de quem foi convidado -------------------------------------------

  // GET /api/firms/me/invites → convites pendentes dirigidos a quem está logado
  @Get('firms/me/invites')
  async myInvites(@Headers('authorization') authorization?: string) {
    return this.firms.myInvites(await this.resolveUser(authorization))
  }

  // POST /api/firms/me/invites/:id/accept
  @Post('firms/me/invites/:id/accept')
  async accept(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    return this.firms.acceptInvite(await this.resolveUser(authorization), id)
  }

  // POST /api/firms/me/invites/:id/decline
  @Post('firms/me/invites/:id/decline')
  async decline(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    return this.firms.declineInvite(await this.resolveUser(authorization), id)
  }

  // POST /api/firms/me/leave → o advogado sai do escritório por vontade própria
  @Post('firms/me/leave')
  async leave(@Headers('authorization') authorization?: string) {
    return this.firms.leave(await this.resolveUser(authorization))
  }

  // GET /api/firms/:slug  (público) — página institucional do escritório
  // Depois das rotas /firms/me/*, senão o Nest casaria "me" como slug.
  @Get('firms/:slug')
  async getBySlug(@Param('slug') slug: string) {
    return this.firms.getBySlug(slug)
  }
}
