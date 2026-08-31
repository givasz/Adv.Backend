import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
  UnauthorizedException,
} from '@nestjs/common'
import { FirmsService } from './firms.service'
import { SessionService } from '../auth/session.service'
import type { RequisicaoComAuth } from '../auth/session-context'

@Controller()
export class FirmsController {
  constructor(
    private readonly firms: FirmsService,
    private readonly sessions: SessionService,
  ) {}

  // O escritório é sempre de alguém: diferente do perfil individual (que tem um
  // rascunho anônimo no Free), aqui não existe dono demo. Sem sessão válida, 401 —
  // senão qualquer visitante editaria o escritório do vizinho.
  private resolveUser(req: RequisicaoComAuth): Promise<string> {
    return this.sessions.requireUser(
      req,
      'Entre na sua conta para gerenciar o escritório',
    )
  }

  // GET /api/firms/me  → escritório que o usuário administra (para o editor); null se não existe
  @Get('firms/me')
  async getMine(@Req() req: RequisicaoComAuth) {
    return this.firms.getMine(await this.resolveUser(req))
  }

  // PUT /api/firms/me  → cria/atualiza os dados INSTITUCIONAIS do escritório.
  // A lista de advogados NÃO vem por aqui: membro entra por convite (POST members).
  @Put('firms/me')
  async saveMine(@Body() body: any, @Req() req: RequisicaoComAuth) {
    return this.firms.createOrUpdate(await this.resolveUser(req), body)
  }

  // POST /api/firms/me/members  → { email, role? } convida um advogado
  @Post('firms/me/members')
  async invite(
    @Body() body: { email?: string; role?: string },
    @Req() req: RequisicaoComAuth,
  ) {
    return this.firms.invite(await this.resolveUser(req), body?.email, body?.role)
  }

  // DELETE /api/firms/me/members/:kind/:id  → desfaz o vínculo (membership) ou
  // cancela o convite por e-mail (invite). O perfil da pessoa nunca é apagado.
  @Delete('firms/me/members/:kind/:id')
  async removeMember(
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Req() req: RequisicaoComAuth,
  ) {
    return this.firms.removeMember(await this.resolveUser(req), kind, id)
  }

  // ---- Advogados listados sem conta -----------------------------------------
  //
  // Montar a página exigia que cada advogado criasse conta e aceitasse convite
  // antes de aparecer. Aqui o escritório lista quem é do quadro e a página fica
  // pronta no mesmo dia; a conta de cada um vem depois. Ver firms.service.

  // POST /api/firms/me/roster  → { name, oabNumber?, area? }
  @Post('firms/me/roster')
  async addRoster(
    @Body() body: { name?: string; oabNumber?: string; area?: string },
    @Req() req: RequisicaoComAuth,
  ) {
    return this.firms.addRosterLawyer(await this.resolveUser(req), body)
  }

  // POST /api/firms/me/roster/:id/email  → { email, role? }
  // Associa um e-mail ao advogado listado: é o passo que lhe dá autonomia.
  @Post('firms/me/roster/:id/email')
  async linkRoster(
    @Param('id') id: string,
    @Body() body: { email?: string; role?: string },
    @Req() req: RequisicaoComAuth,
  ) {
    return this.firms.linkRosterLawyer(await this.resolveUser(req), id, body?.email, body?.role)
  }

  // DELETE /api/firms/me/roster/:id → tira da lista (não há conta a mexer)
  @Delete('firms/me/roster/:id')
  async removeRoster(@Param('id') id: string, @Req() req: RequisicaoComAuth) {
    return this.firms.removeRosterLawyer(await this.resolveUser(req), id)
  }

  // ---- Lado de quem foi convidado -------------------------------------------

  // GET /api/firms/me/invites → convites pendentes dirigidos a quem está logado
  @Get('firms/me/invites')
  async myInvites(@Req() req: RequisicaoComAuth) {
    return this.firms.myInvites(await this.resolveUser(req))
  }

  // POST /api/firms/me/invites/:id/accept
  @Post('firms/me/invites/:id/accept')
  async accept(@Param('id') id: string, @Req() req: RequisicaoComAuth) {
    return this.firms.acceptInvite(await this.resolveUser(req), id)
  }

  // POST /api/firms/me/invites/:id/decline
  @Post('firms/me/invites/:id/decline')
  async decline(@Param('id') id: string, @Req() req: RequisicaoComAuth) {
    return this.firms.declineInvite(await this.resolveUser(req), id)
  }

  // POST /api/firms/me/leave → o advogado sai do escritório por vontade própria
  @Post('firms/me/leave')
  async leave(@Req() req: RequisicaoComAuth) {
    return this.firms.leave(await this.resolveUser(req))
  }

  // GET /api/firms/:slug  (público) — página institucional do escritório
  // Depois das rotas /firms/me/*, senão o Nest casaria "me" como slug.
  @Get('firms/:slug')
  async getBySlug(@Param('slug') slug: string) {
    return this.firms.getBySlug(slug)
  }
}
