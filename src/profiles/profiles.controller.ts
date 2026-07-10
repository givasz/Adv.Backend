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
import { isAdminAuthenticated } from '../admin/admin-auth'
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

  // ---- Conferência de OAB ----

  // POST /api/profiles/me/oab/request  → advogado solicita (vira "pending")
  // Só disponível nos planos pagos (o service reforça a regra).
  @Post('profiles/me/oab/request')
  requestOab(@Headers('authorization') authorization?: string) {
    return this.profiles.requestOab(this.resolveUser(authorization))
  }

  // GET /api/admin/oab/pending  → fila de conferências (admin)
  @Get('admin/oab/pending')
  pendingOab(
    @Headers('x-admin-token') token?: string,
    @Headers('authorization') authorization?: string,
  ) {
    this.assertAdmin(token, authorization)
    return this.profiles.listPendingOab()
  }

  // POST /api/admin/profiles/:id/oab/decision  → { decision: 'verify'|'reject', reason? }
  @Post('admin/profiles/:id/oab/decision')
  decideOab(
    @Param('id') id: string,
    @Body() body: { decision: 'verify' | 'reject'; reason?: string },
    @Headers('x-admin-token') token?: string,
    @Headers('authorization') authorization?: string,
  ) {
    this.assertAdmin(token, authorization)
    return this.profiles.decideOab(id, body.decision, body.reason)
  }
}
