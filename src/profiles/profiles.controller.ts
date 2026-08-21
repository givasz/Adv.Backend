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
} from '@nestjs/common'
import { ProfilesService } from './profiles.service'
import { adminLabel, isAdminAuthenticated } from '../admin/admin-auth'
import { userIdFromHeader } from '../auth/user-auth'

// Usuário anônimo do protótipo (Free sem conta): compartilha o rascunho demo.
// Quando há uma sessão válida (Authorization: Bearer), usamos o dono real.
const DEMO_USER = 'demo-user-id'

@Controller()
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  // Resolve o dono da requisição: sessão do usuário (Bearer) ou o anônimo demo.
  private resolveUser(authorization?: string): string {
    return userIdFromHeader(authorization) ?? DEMO_USER
  }

  // Aceita a sessão de admin (Authorization: Bearer) ou o token estático legado
  // (x-admin-token = ADMIN_TOKEN), unificando o acesso com o painel de denúncias.
  private assertAdmin(token?: string, authorization?: string) {
    if (!isAdminAuthenticated(authorization, token)) {
      throw new ForbiddenException('Acesso de administrador inválido')
    }
  }

  // GET /api/directory?q=&area=
  @Get('directory')
  search(@Query('q') q?: string, @Query('area') area?: string) {
    return this.profiles.search(q, area)
  }

  // GET /api/profiles/me
  @Get('profiles/me')
  me(@Headers('authorization') authorization?: string) {
    return this.profiles.getMine(this.resolveUser(authorization))
  }

  // PUT /api/profiles/me
  @Put('profiles/me')
  update(@Body() body: any, @Headers('authorization') authorization?: string) {
    return this.profiles.update(this.resolveUser(authorization), body)
  }

  // POST /api/profiles/me/plan  → { plan: 'free' | 'pro' | 'premium' }
  // Ativação de assinatura. Hoje SIMULADA (plataforma em teste, sem cobrança): o
  // checkout do front confirma e chama aqui. É a única porta que grava o plano —
  // o PUT /profiles/me ignora `plan` no corpo. Quando entrar o billing real, o
  // webhook do provedor passa a ser quem chama.
  @Post('profiles/me/plan')
  setPlan(@Body() body: { plan?: string }, @Headers('authorization') authorization?: string) {
    return this.profiles.setPlan(this.resolveUser(authorization), body?.plan)
  }

  // GET /api/profiles/slug-available?slug=&name=
  // ANTES da rota /profiles/:slug — senão o Nest casaria "slug-available" como slug.
  @Get('profiles/slug-available')
  slugAvailable(
    @Query('slug') slug?: string,
    @Query('name') name?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return this.profiles.slugAvailability(this.resolveUser(authorization), slug ?? '', name)
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
