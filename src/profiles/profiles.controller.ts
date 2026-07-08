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

// Autenticação (JWT) omitida neste sketch — `me()`/`update()` usariam @Req().user.id.
const DEMO_USER = 'demo-user-id'

@Controller()
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

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
  me() {
    return this.profiles.getMine(DEMO_USER)
  }

  // PUT /api/profiles/me
  @Put('profiles/me')
  update(@Body() body: any) {
    return this.profiles.update(DEMO_USER, body)
  }

  // GET /api/profiles/:slug  (público)
  @Get('profiles/:slug')
  getBySlug(@Param('slug') slug: string) {
    return this.profiles.getBySlug(slug)
  }

  // ---- Conferência de OAB ----

  // POST /api/profiles/me/oab/request  → advogado solicita (vira "pending")
  @Post('profiles/me/oab/request')
  requestOab() {
    return this.profiles.requestOab(DEMO_USER)
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
