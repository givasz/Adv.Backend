import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common'
import { ProfilesService } from './profiles.service'
import { AdminService } from '../admin/admin.service'
import { SessionService } from '../auth/session.service'
import type { RequisicaoComAuth } from '../auth/session-context'

@Controller()
export class ProfilesController {
  constructor(
    private readonly profiles: ProfilesService,
    private readonly sessions: SessionService,
    private readonly admin: AdminService,
  ) {}

  /**
   * Dono da requisição. Antes, sem sessão a API caía num usuário fixo
   * ("demo-user-id") COMPARTILHADO por todo mundo: quem preenchesse o editor sem
   * conta gravava nome, WhatsApp e e-mail numa linha que o próximo visitante
   * anônimo abria e lia. Escrever exige sessão; sem conta, o rascunho é do
   * navegador (frontend/src/lib/api.ts), onde nenhum outro visitante alcança.
   */
  private requireUser(req: RequisicaoComAuth): Promise<string> {
    return this.sessions.requireUser(req, 'Entre na sua conta para salvar o perfil.')
  }

  // GET /api/directory?q=&area=
  @Get('directory')
  search(@Query('q') q?: string, @Query('area') area?: string) {
    return this.profiles.search(q, area)
  }

  /**
   * GET /api/profiles/me — o perfil de quem está logado.
   *
   * Sem sessão responde 401, e não `null`. A diferença não é de estilo: `null`
   * também é a resposta de "conta sem perfil ainda", e o front tratava os dois
   * casos como o mesmo — quem tinha o cookie vencido (ou bloqueado pelo
   * navegador) caía no assistente de criação, em branco, com o próprio nome no
   * cabeçalho, como se o perfil tivesse sumido. Um 401 diz o que houve.
   */
  @Get('profiles/me')
  async me(@Req() req: RequisicaoComAuth) {
    const userId = await this.sessions.requireUser(req, 'Entre na sua conta para ver seu perfil.')
    return this.profiles.getMine(userId)
  }

  // PUT /api/profiles/me
  @Put('profiles/me')
  async update(@Body() body: any, @Req() req: RequisicaoComAuth) {
    return this.profiles.update(await this.requireUser(req), body)
  }

  // POST /api/profiles/me/plan  → { plan: 'free' | 'pro' | 'premium' }
  // Ativação de assinatura. Hoje SIMULADA (plataforma em teste, sem cobrança): o
  // checkout do front confirma e chama aqui. É a única porta que grava o plano —
  // o PUT /profiles/me ignora `plan` no corpo. Quando entrar o billing real, o
  // webhook do provedor passa a ser quem chama.
  @Post('profiles/me/plan')
  async setPlan(@Body() body: { plan?: string }, @Req() req: RequisicaoComAuth) {
    return this.profiles.setPlan(await this.requireUser(req), body?.plan)
  }

  // GET /api/profiles/slug-available?slug=&name=
  // ANTES da rota /profiles/:slug — senão o Nest casaria "slug-available" como slug.
  @Get('profiles/slug-available')
  async slugAvailable(
    @Req() req: RequisicaoComAuth,
    @Query('slug') slug?: string,
    @Query('name') name?: string,
  ) {
    // Consulta pública de disponibilidade: sem sessão não há "meu próprio slug",
    // então um id impossível faz a comparação de dono nunca casar.
    const userId = (await this.sessions.userIdFrom(req)) ?? 'anonimo'
    return this.profiles.slugAvailability(userId, slug ?? '', name)
  }

  // GET /api/profiles/:slug  (público)
  @Get('profiles/:slug')
  getBySlug(@Param('slug') slug: string) {
    return this.profiles.getBySlug(slug)
  }

  // GET /api/admin/profiles?q=&limite=&offset=  → busca do painel (qualquer status)
  @Get('admin/profiles')
  async adminSearchProfiles(
    @Req() req: RequisicaoComAuth,
    @Query('q') q?: string,
    @Query('limite') limite?: string,
    @Query('offset') offset?: string,
    @Headers('x-admin-token') token?: string,
  ) {
    await this.admin.exigir(req, 'contas:ler', token)
    return this.profiles.adminSearch(q, limite, offset)
  }
}
