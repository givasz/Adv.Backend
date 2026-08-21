import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Post,
  Put,
  Query,
  UnauthorizedException,
} from '@nestjs/common'
import { ProfilesService } from './profiles.service'
import { adminLabel, isAdminAuthenticated } from '../admin/admin-auth'
import { userIdFromHeader } from '../auth/user-auth'
import { logSecurityEvent } from '../security/audit-log'

@Controller()
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  /**
   * Dono da requisição. Antes, sem sessão a API caía num usuário fixo
   * ("demo-user-id") COMPARTILHADO por todo mundo: quem preenchesse o editor sem
   * conta gravava nome, WhatsApp e e-mail numa linha que o próximo visitante
   * anônimo abria e lia. Escrever exige sessão; sem conta, o rascunho é do
   * navegador (frontend/src/lib/api.ts), onde nenhum outro visitante alcança.
   */
  private requireUser(authorization?: string): string {
    const userId = userIdFromHeader(authorization)
    if (!userId) {
      throw new UnauthorizedException('Entre na sua conta para salvar o perfil.')
    }
    return userId
  }

  // Aceita a sessão de admin (Authorization: Bearer) ou o token estático legado
  // (x-admin-token = ADMIN_TOKEN), unificando o acesso com o painel de denúncias.
  private assertAdmin(token?: string, authorization?: string) {
    if (!isAdminAuthenticated(authorization, token)) {
      logSecurityEvent({ event: 'access_denied', resource: 'admin:profiles', result: 'negado' })
      throw new ForbiddenException('Acesso de administrador inválido')
    }
  }

  // GET /api/directory?q=&area=
  @Get('directory')
  search(@Query('q') q?: string, @Query('area') area?: string) {
    return this.profiles.search(q, area)
  }

  // GET /api/profiles/me — sem sessão devolve null (o editor usa o rascunho local).
  @Get('profiles/me')
  me(@Headers('authorization') authorization?: string) {
    const userId = userIdFromHeader(authorization)
    return userId ? this.profiles.getMine(userId) : null
  }

  // PUT /api/profiles/me
  @Put('profiles/me')
  update(@Body() body: any, @Headers('authorization') authorization?: string) {
    return this.profiles.update(this.requireUser(authorization), body)
  }

  // POST /api/profiles/me/plan  → { plan: 'free' | 'pro' | 'premium' }
  // Ativação de assinatura. Hoje SIMULADA (plataforma em teste, sem cobrança): o
  // checkout do front confirma e chama aqui. É a única porta que grava o plano —
  // o PUT /profiles/me ignora `plan` no corpo. Quando entrar o billing real, o
  // webhook do provedor passa a ser quem chama.
  @Post('profiles/me/plan')
  setPlan(@Body() body: { plan?: string }, @Headers('authorization') authorization?: string) {
    return this.profiles.setPlan(this.requireUser(authorization), body?.plan)
  }

  // GET /api/profiles/slug-available?slug=&name=
  // ANTES da rota /profiles/:slug — senão o Nest casaria "slug-available" como slug.
  @Get('profiles/slug-available')
  slugAvailable(
    @Query('slug') slug?: string,
    @Query('name') name?: string,
    @Headers('authorization') authorization?: string,
  ) {
    // Consulta pública de disponibilidade: sem sessão não há "meu próprio slug",
    // então um id impossível faz a comparação de dono nunca casar.
    return this.profiles.slugAvailability(
      userIdFromHeader(authorization) ?? 'anonimo',
      slug ?? '',
      name,
    )
  }

  // GET /api/profiles/:slug  (público)
  @Get('profiles/:slug')
  getBySlug(@Param('slug') slug: string) {
    return this.profiles.getBySlug(slug)
  }

  // GET /api/admin/profiles?q=  → busca de perfis pelo painel (qualquer status)
  @Get('admin/profiles')
  adminSearchProfiles(
    @Query('q') q?: string,
    @Headers('x-admin-token') token?: string,
    @Headers('authorization') authorization?: string,
  ) {
    this.assertAdmin(token, authorization)
    return this.profiles.adminSearch(q)
  }
}
