import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common'
import { SessionService } from '../auth/session.service'
import type { RequisicaoComAuth } from '../auth/session-context'
import { AgendaService } from './agenda.service'

@Controller('agenda')
export class AgendaController {
  constructor(private readonly agenda: AgendaService, private readonly sessions: SessionService) {}

  @Get('entries')
  async entries(@Req() req: RequisicaoComAuth, @Query('from') from?: string, @Query('to') to?: string) {
    return this.agenda.entradas(await this.sessions.requireUser(req, 'Entre na sua conta para acessar a agenda.'), from, to)
  }
  @Post('entries')
  async create(@Req() req: RequisicaoComAuth, @Body() body: any) { return this.agenda.criarEntrada(await this.sessions.requireUser(req, 'Entre na sua conta para acessar a agenda.'), body) }
  @Put('entries/:id')
  async update(@Req() req: RequisicaoComAuth, @Param('id') id: string, @Body() body: any) { return this.agenda.editarEntrada(await this.sessions.requireUser(req, 'Entre na sua conta para acessar a agenda.'), id, body) }
  @Delete('entries/:id')
  async delete(@Req() req: RequisicaoComAuth, @Param('id') id: string) { return this.agenda.apagarEntrada(await this.sessions.requireUser(req, 'Entre na sua conta para acessar a agenda.'), id) }
  @Get('requests')
  async requests(@Req() req: RequisicaoComAuth, @Query('page') page?: string, @Query('status') status?: string) { return this.agenda.solicitacoes(await this.sessions.requireUser(req, 'Entre na sua conta para acessar a agenda.'), Number(page ?? 1), status ?? 'all') }
  @Patch('requests/:id')
  async decide(@Req() req: RequisicaoComAuth, @Param('id') id: string, @Body() body: { status: string; startsAt?: string; durationMin?: number }) { return this.agenda.decidir(await this.sessions.requireUser(req, 'Entre na sua conta para acessar a agenda.'), id, body) }
  @Delete('requests/:id')
  async removeRequest(@Req() req: RequisicaoComAuth, @Param('id') id: string) { return this.agenda.apagarSolicitacao(await this.sessions.requireUser(req, 'Entre na sua conta para acessar a agenda.'), id) }
}
