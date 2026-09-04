import {
  Body,
  Controller,
  Get,
  Headers,
  Ip,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common'
import { clientIp } from '../security/net'
import { checkRateLimit } from '../security/rate-limit'

/**
 * O mínimo de uma resposta HTTP para servir bytes de imagem.
 *
 * Interface local, e não `@types/express`, pela mesma razão de
 * `auth/session-context.ts`: o projeto não instala os tipos do express, e uma
 * dependência nova para descrever três métodos não se paga.
 */
interface RespostaHttp {
  setHeader(nome: string, valor: string): void
  end(corpo?: Buffer): void
  statusCode: number
}
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

  // GET /api/directory foi removida (03/09/2026) — nunca teve tela, e superfície
  // pública sem uso só acumula achado de auditoria. Ver profiles.service.ts.

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

  /**
   * PUT /api/profiles/me
   *
   * O IP viaja até o serviço porque o save pode ser o instante em que um perfil
   * vai ao ar — e esse instante é registro de acesso do art. 15 do Marco Civil.
   * Quem decide se grava (e não grava em rascunho) é ProfilesService.update.
   */
  @Put('profiles/me')
  async update(
    @Body() body: any,
    @Req() req: RequisicaoComAuth,
    @Ip() ip?: string,
    @Headers('x-forwarded-for') forwardedFor?: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.profiles.update(await this.requireUser(req), body, {
      ip: clientIp(ip, forwardedFor),
      userAgent,
    })
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
  //
  // O IP entra SÓ como chave do teto de gravação de visita, e some — nada dele é
  // persistido (mesma regra de analytics/eventos.ts). O teto nunca bloqueia a
  // página: estourou, a visita apenas não conta. Sem ele, um laço de terminal
  // gravava uma linha de LinkEvent por requisição, para sempre — e "Quem visita
  // você", que é métrica vendida no plano pago, virava número forjável de fora.
  @Get('profiles/:slug')
  getBySlug(
    @Param('slug') slug: string,
    @Ip() ip?: string,
    @Headers('x-forwarded-for') forwardedFor?: string,
  ) {
    const chave = `view:${clientIp(ip, forwardedFor)}`
    const contarVisita =
      checkRateLimit(chave, { windowMs: 60_000, max: 60 }) &&
      checkRateLimit(chave, { windowMs: 3_600_000, max: 600 })
    return this.profiles.getBySlug(slug, contarVisita)
  }

  /**
   * GET /api/profiles/:slug/avatar  (público) — a foto como imagem servível.
   *
   * É o que faz a prévia do link ter rosto: `og:image` precisa de uma URL que o
   * robô do WhatsApp consiga buscar por HTTP, e a foto está guardada como data
   * URI. Ver ProfilesService.avatarBySlug.
   *
   * O prazo do cache depende de COMO a URL chegou:
   *   • com o `?v=` CERTO (o hash da foto, posto pelo getBySlug no JSON
   *     público): a URL muda junto com a foto, então aqui cabe `immutable` —
   *     o navegador do visitante recorrente nem pergunta de novo;
   *   • sem versão (o `og:image` que os mensageiros buscam) ou com versão que
   *     NÃO BATE: uma hora. A conferência é a diferença entre cache e arma
   *     (auditoria de 03/09): quando só a PRESENÇA do parâmetro decidia,
   *     qualquer um fixava a foto de qualquer perfil por um ano num cache
   *     compartilhado com `?v=qualquercoisa` — e uma censura da moderação, ou a
   *     exclusão da conta, não alcançava mais o que já estava fixado. Com a
   *     conferência, só a versão VIGENTE ganha cache longo; quando a foto muda
   *     ou some, a URL antiga simplesmente deixa de existir (404) e a atual é
   *     outra.
   * O ETag (o mesmo hash) fecha o meio do caminho: cache vencido revalida com
   * um 304 vazio em vez de baixar a foto inteira outra vez.
   *
   * Teto por IP no mesmo espírito do /geo/cep: cada hit custa a coluna de até
   * ~400 KB no banco + um sha256 — sem sessão e sem CSRF, isso precisa de um
   * limite. 120/min acomoda a página de escritório cheia de fotos e sobra.
   */
  @Get('profiles/:slug/avatar')
  async avatar(
    @Param('slug') slug: string,
    @Query('v') v: string | undefined,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() res: RespostaHttp,
    @Ip() ip?: string,
    @Headers('x-forwarded-for') forwardedFor?: string,
  ) {
    const chave = `avatar:${clientIp(ip, forwardedFor)}`
    if (
      !checkRateLimit(chave, { windowMs: 60_000, max: 120 }) ||
      !checkRateLimit(chave, { windowMs: 3_600_000, max: 2000 })
    ) {
      res.statusCode = 429
      res.setHeader('Retry-After', '60')
      return res.end()
    }
    // Só bytes. A rota NÃO redireciona: enquanto redirecionava para a foto
    // hospedada fora, ela era um redirecionamento aberto na nossa origem — conta
    // grátis, `avatarUrl` apontando para onde o dono quisesse, e um link do
    // domínio da plataforma levando a qualquer lugar. Ver ProfilesService.
    const foto = await this.profiles.avatarBySlug(slug)
    const etag = `"${foto.versao}"`
    res.setHeader('ETag', etag)
    res.setHeader(
      'Cache-Control',
      v === foto.versao ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    )
    // A foto é imagem, e só. Sem isto, um arquivo forjado que passasse pelo
    // saneamento poderia ser servido como outra coisa pelo palpite do navegador.
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (ifNoneMatch === etag) {
      res.statusCode = 304
      return res.end()
    }
    res.setHeader('Content-Type', foto.contentType)
    return res.end(foto.bytes)
  }

  // GET /api/sitemap  (público) → [{ slug, updatedAt }] dos perfis publicados.
  // Alimenta o /sitemap.xml servido pelo Netlify (frontend/netlify/edge-functions).
  @Get('sitemap')
  sitemap() {
    return this.profiles.sitemap()
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
