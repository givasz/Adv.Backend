import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { POLICY_VERSION } from '../oab/compliance'
import { aceiteVigente, TERMS_VERSION } from '../legal/termos'
import { slugify } from '../plans'
import { burnPasswordTime, hashPassword, verifyPassword } from './user-auth'
import { SessionService } from './session.service'
import type { RequisicaoComAuth } from './session-context'
import { passwordProblem } from '../password'
import { clampText, EMAIL_MAX } from '../security/sanitize'
import { NAME_MAX } from '../plans'
import { planoVigente } from '../assinatura'
import { CorreioService } from '../mail/correio.service'
import { conferirToken, emitirToken, gastarToken } from './tokens-de-email'

// Formato de e-mail simples (o mesmo do front). Quem prova que o endereço existe
// e é da pessoa é a confirmação por e-mail (confirmarEmail, abaixo).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Violação de índice único do Prisma (P2002): duas escritas correndo para o mesmo valor. */
function erroDeUnicidade(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002'
}

export interface AuthSession {
  /** epoch ms do vencimento da sessão (informativo — quem manda é o cookie). */
  expiresAt: number
  /** Token anti-CSRF desta sessão, devolvido no cabeçalho das escritas. */
  csrfToken: string
  remember: boolean
  user: {
    id: string
    email: string
    name?: string
    plan: string
    /**
     * Os Termos mudaram desde o aceite desta conta (ou nunca houve aceite)?
     *
     * Vai no corpo de /login, /signup e /me porque é a tela que precisa saber —
     * é ela que mostra o pedido de reaceite. Não é uma trava de acesso: quem
     * está dentro continua podendo ler o painel, exportar os dados e sair. O que
     * o reaceite pendente trava é PUBLICAR (ver profiles.service), que é o ato
     * em que os Termos importam de verdade.
     */
    termsPending: boolean
    /** Versão aceita por esta conta — vazia quando nunca houve aceite. */
    termsVersion: string
    /**
     * Falta confirmar o e-mail — e o correio está ligado para mandar o link.
     *
     * Com o correio desligado é sempre `false`: pedir a confirmação de um link
     * que não vai chegar seria uma faixa que ninguém consegue fazer sumir.
     */
    emailPending: boolean
    /**
     * A conta tem senha? Conta criada pelo "Continuar com o Google" nasce sem.
     * A tela usa para trocar "digite a senha" por "crie uma senha antes" onde a
     * senha é exigida (trocar senha, excluir a conta).
     */
    temSenha: boolean
    /** A conta está ligada a uma conta Google. */
    google: boolean
  }
}

/** Identidade que chega de src/auth/google.ts — já conferida e com e-mail confirmado. */
export interface IdentidadeParaEntrar {
  sub: string
  email: string
  nome: string
}

export type ResultadoGoogle =
  /** Conta nova, e o aceite dos Termos ainda não veio. Nada foi criado. */
  | { etapa: 'aceite'; email: string; nome: string }
  | {
      etapa: 'sessao'
      sessao: AuthSession
      novaConta: boolean
      /** A conta Google acabou de ser ligada a uma conta que já existia. */
      vinculou: boolean
      /** A senha antiga foi desligada (conta com e-mail nunca confirmado). */
      senhaDesligada: boolean
    }

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    // Opcional só para os testes que não tratam de e-mail. No app o módulo
    // importa o CorreioModule, e a ausência derrubaria o boot — que é o certo.
    private readonly correio?: CorreioService,
  ) {}

  /** O envio de e-mails está ligado? */
  get correioAtivo(): boolean {
    return !!this.correio?.ativo
  }

  // Coerção antes de qualquer coisa: o corpo é JSON livre, e `email: 12345`
  // chegando num `.trim()` viraria 500 (erro interno vazado) em vez de 400.
  private normalizeEmail(email?: unknown): string {
    return clampText(email, EMAIL_MAX).toLowerCase()
  }

  // Cria um perfil inicial (rascunho Free) junto com a conta, para que
  // GET/PUT /profiles/me funcionem imediatamente após o cadastro.
  private starterProfile(name?: string) {
    const base = slugify(name || 'advogado')
    const slug = `${base}-${Math.floor(1000 + Math.random() * 9000)}`
    return {
      slug,
      name: name ?? '',
      oabNumber: '',
      plan: 'free' as const,
      published: false,
      policyVersion: POLICY_VERSION,
    }
  }

  // Abrir sessão GRAVA uma linha (ver session.service.ts) e escreve o cookie
  // HttpOnly na resposta: é a linha que o "sair" apaga, e é o cookie que o
  // navegador guarda sozinho. Nenhum token volta no corpo — se voltasse, o
  // JavaScript da página teria de guardá-lo em algum lugar, e o lugar seria o
  // localStorage, que é exatamente o que este desenho existe para evitar.
  private async sessionFor(
    req: RequisicaoComAuth,
    id: string,
    email: string,
    name: string | undefined,
    plan: string,
    lembrar: boolean,
    termsVersion: string,
    emailVerifiedAt: Date | null,
    metodos: { temSenha: boolean; google: boolean },
  ): Promise<AuthSession> {
    const { expiresAt, csrfToken, remember } = await this.sessions.abrir(req, id, lembrar)
    return {
      expiresAt,
      csrfToken,
      remember,
      user: {
        id,
        email,
        name: name || undefined,
        plan,
        termsVersion,
        termsPending: !aceiteVigente(termsVersion),
        emailPending: !emailVerifiedAt && this.correioAtivo,
        ...metodos,
      },
    }
  }

  async signup(
    req: RequisicaoComAuth,
    email?: unknown,
    password?: unknown,
    name?: unknown,
    lembrar = true,
    aceite?: { aceitou: unknown; ip: string },
  ): Promise<AuthSession> {
    const mail = this.normalizeEmail(email)
    if (!EMAIL_RE.test(mail)) throw new BadRequestException('E-mail inválido.')
    // O ACEITE É REQUISITO DO CADASTRO, conferido aqui e não só na tela.
    //
    // Uma caixa marcada no navegador não é prova de nada — quem chama a rota
    // direto nunca vê caixa nenhuma. É esta recusa que faz existir a regra "toda
    // conta desta base aceitou os Termos", que é a frase que se diz num processo.
    if (aceite?.aceitou !== true) {
      throw new BadRequestException(
        'É preciso aceitar os Termos de Uso e a Política de Privacidade para criar a conta.',
      )
    }
    // Regras de senha: ver src/password.ts. Valem só no CADASTRO — o login não
    // pode trancar quem criou a conta sob a regra antiga.
    const senha = typeof password === 'string' ? password : ''
    const problema = passwordProblem(senha, mail)
    if (problema) throw new BadRequestException(problema)
    const exists = await this.prisma.user.findUnique({ where: { email: mail }, select: { id: true } })
    if (exists) throw new ConflictException('Já existe uma conta com este e-mail.')

    const cleanName = clampText(name, NAME_MAX) || undefined
    const user = await this.prisma.user.create({
      data: {
        email: mail,
        password: await hashPassword(senha),
        // O aceite entra na MESMA transação que cria a conta. Gravar depois
        // abriria a janela em que uma conta existe sem registro de aceite — e a
        // única conta que interessa numa disputa seria justamente a que caiu na
        // janela.
        termsAcceptedAt: new Date(),
        termsVersion: TERMS_VERSION,
        termsIp: aceite.ip.slice(0, 60),
        profile: { create: this.starterProfile(cleanName) },
      },
      select: { id: true, email: true, profile: { select: { id: true, name: true, plan: true } } },
    })
    if (user.profile) await this.resolvePendingInvites(mail, user.profile.id)

    // Confirmação do e-mail. NÃO trava o cadastro: a pessoa entra na hora, monta
    // o perfil, e o painel lembra de confirmar. Travar aqui seria mandar embora,
    // no primeiro minuto, quem digitou o e-mail certo e só não abriu a caixa.
    await this.enviarConfirmacao(user.id, user.email, user.profile?.name || cleanName)

    return this.sessionFor(
      req,
      user.id,
      user.email,
      user.profile?.name || cleanName,
      user.profile ? planoVigente(user.profile) : 'free',
      lembrar,
      TERMS_VERSION,
      null,
      { temSenha: true, google: false },
    )
  }

  /**
   * Aceite de quem JÁ tem conta — o caminho do reaceite quando o texto muda.
   *
   * Existe por duas razões. A primeira é a base anterior a esta mudança: milhares
   * de contas sem registro nenhum, que não dá para apagar nem para presumir. A
   * segunda é o item 13 dos Termos, que promete avisar mudanças relevantes; sem
   * uma porta como esta, "avisar" seria um texto novo publicado em silêncio e a
   * esperança de que ninguém reparasse.
   *
   * Carimba sempre a versão do SERVIDOR. O corpo diz apenas "aceito".
   */
  async aceitarTermos(userId: string, ip: string): Promise<{ termsVersion: string }> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { termsAcceptedAt: new Date(), termsVersion: TERMS_VERSION, termsIp: ip.slice(0, 60) },
    })
    return { termsVersion: TERMS_VERSION }
  }

  // Convites feitos para um e-mail SEM conta ficam guardados em FirmInvite (o
  // FirmMembership exige um Profile). No cadastro o convite vira vínculo pendente
  // e aparece no painel do advogado — que aceita ou recusa. Um advogado pertence a
  // no máximo um escritório (profileId é único), então só o primeiro é convertido;
  // os outros seguem à espera de uma decisão.
  private async resolvePendingInvites(email: string, profileId: string) {
    const primeiro = await this.prisma.firmInvite.findFirst({
      where: { email },
      orderBy: { createdAt: 'asc' },
    })
    if (!primeiro) return
    try {
      await this.prisma.firmMembership.create({
        data: { firmId: primeiro.firmId, profileId, role: primeiro.role, status: 'invited' },
      })
      await this.prisma.firmInvite.delete({ where: { id: primeiro.id } })
    } catch {
      // Convite inválido (escritório apagado) não pode derrubar o cadastro.
    }
  }

  async login(
    req: RequisicaoComAuth,
    email?: unknown,
    password?: unknown,
    lembrar = true,
  ): Promise<AuthSession> {
    const mail = this.normalizeEmail(email)
    const senha = typeof password === 'string' ? password : ''
    const user = await this.prisma.user.findUnique({
      where: { email: mail },
      select: {
        id: true,
        email: true,
        password: true,
        suspendedUntil: true,
        suspendedReason: true,
        closedAt: true,
        closedReason: true,
        termsVersion: true,
        emailVerifiedAt: true,
        googleSub: true,
        // Plano VIGENTE, não o contratado: o retrato da sessão é o que a tela
        // consulta antes de o perfil chegar, e um "premium" aqui destravaria por
        // um instante o que a assinatura vencida não entrega mais.
        profile: {
          select: {
            name: true,
            plan: true,
            planStatus: true,
            currentPeriodEnd: true,
            graceUntil: true,
          },
        },
      },
    })
    // E-mail inexistente — e conta SEM senha, criada pelo Google — pagam o preço
    // de uma verificação de senha. Sem isso, a diferença de tempo entre "não
    // existe", "entra só com o Google" e "senha errada" entrega quais e-mails têm
    // conta aqui, e como cada uma entra. A mensagem já era única; o tempo também é.
    if (!user || !user.password) {
      await burnPasswordTime(senha)
      throw new UnauthorizedException('E-mail ou senha incorretos.')
    }
    if (!(await verifyPassword(senha, user.password))) {
      throw new UnauthorizedException('E-mail ou senha incorretos.')
    }

    // A checagem das sanções vem DEPOIS da senha de propósito: quem erra a senha
    // continua recebendo a mesma resposta de sempre, e só quem prova ser o dono
    // da conta descobre que ela foi suspensa — e por quê. Dizer antes
    // transformaria o login numa consulta pública de quem foi sancionado.
    this.conferirSancoes(user)

    return this.sessionFor(
      req,
      user.id,
      user.email,
      user.profile?.name || undefined,
      user.profile ? planoVigente(user.profile) : 'free',
      lembrar,
      user.termsVersion,
      user.emailVerifiedAt,
      { temSenha: true, google: !!user.googleSub },
    )
  }

  /**
   * Sanções que alcançam a CONTA (degraus 4 e 5 de docs/politica-de-sancoes.md).
   * Valem para toda porta de entrada — senha ou Google —, e por isso moram aqui.
   *
   * A mensagem traz o MOTIVO escrito pelo administrador. É o mesmo texto do
   * registro: uma sanção que a pessoa não consegue ler é uma sanção que ela não
   * tem como contestar.
   */
  private conferirSancoes(user: {
    closedAt: Date | null
    closedReason: string
    suspendedUntil: Date | null
    suspendedReason: string
  }): void {
    if (user.closedAt) {
      throw new UnauthorizedException(
        `Esta conta foi encerrada.${user.closedReason ? ` Motivo: ${user.closedReason}` : ''} ` +
          'Se você discorda, responda ao aviso que enviamos ou fale com o suporte.',
      )
    }
    if (user.suspendedUntil && user.suspendedUntil.getTime() > Date.now()) {
      const ate = user.suspendedUntil.toLocaleDateString('pt-BR')
      throw new UnauthorizedException(
        `Esta conta está suspensa até ${ate}.` +
          `${user.suspendedReason ? ` Motivo: ${user.suspendedReason}` : ''} ` +
          'Se você discorda, responda ao aviso que enviamos ou fale com o suporte.',
      )
    }
  }

  /**
   * "Continuar com o Google" — a identidade já conferida vira sessão.
   *
   * Quem chama é o google.controller, com a identidade que o Google confirmou
   * (e-mail confirmado incluído: google.ts recusa o que não foi). Três casos:
   *
   *   1. A conta Google já está ligada a uma conta daqui → entra. Pelo `sub`, e
   *      não pelo e-mail: o e-mail pode mudar dos dois lados, o `sub` não.
   *   2. Existe conta com o mesmo e-mail → liga as duas e entra. Se o e-mail
   *      dessa conta NUNCA foi confirmado, a senha é desligada e as outras
   *      sessões caem — ver o comentário no ponto.
   *   3. Não existe conta → sem o aceite dos Termos, devolve `aceite` e não cria
   *      nada (é a mesma recusa do cadastro); com ele, cria a conta sem senha.
   */
  async entrarComGoogle(
    req: RequisicaoComAuth,
    identidade: IdentidadeParaEntrar,
    opcoes: { lembrar: boolean; aceitouTermos: boolean; ip: string },
  ): Promise<ResultadoGoogle> {
    const email = this.normalizeEmail(identidade.email)
    const sub = typeof identidade.sub === 'string' ? identidade.sub : ''
    if (!EMAIL_RE.test(email) || !sub) {
      throw new BadRequestException('A conta Google não informou um e-mail válido.')
    }
    const campos = {
      id: true,
      email: true,
      password: true,
      googleSub: true,
      suspendedUntil: true,
      suspendedReason: true,
      closedAt: true,
      closedReason: true,
      termsVersion: true,
      emailVerifiedAt: true,
      // Plano VIGENTE — mesma razão do login.
      profile: {
        select: { name: true, plan: true, planStatus: true, currentPeriodEnd: true, graceUntil: true },
      },
    } as const

    let user = await this.prisma.user.findUnique({ where: { googleSub: sub }, select: campos })
    let vinculou = false
    let senhaDesligada = false

    if (!user) {
      const doEmail = await this.prisma.user.findUnique({ where: { email }, select: campos })
      if (doEmail) {
        if (doEmail.googleSub && doEmail.googleSub !== sub) {
          throw new ConflictException(
            'Esta conta do advoc.me já está ligada a outra conta Google. Entre com aquela, ou com e-mail e senha.',
          )
        }
        // Sanção ANTES de ligar: conta suspensa não ganha uma porta nova.
        this.conferirSancoes(doEmail)

        // O PRÉ-SEQUESTRO. Alguém cria uma conta aqui com o e-mail da vítima e
        // uma senha que só ele sabe, e espera. Um dia a vítima toca em "Continuar
        // com o Google", cai nessa conta, monta o perfil — e o outro continua
        // lá dentro, com a senha dele. O que separa o dono do invasor é o e-mail
        // confirmado: se a conta nunca provou que a caixa é de quem a criou, e o
        // Google acabou de provar que é de quem está entrando, a senha antiga não
        // é de ninguém confiável. Sai a senha, caem as sessões.
        //
        // Quem cai aqui sendo o dono de verdade (criou com senha e nunca abriu o
        // e-mail de confirmação) perde só a senha — entra pelo Google, e cria outra
        // pelo "Esqueci minha senha" se quiser. A tela explica.
        const confirmado = !!doEmail.emailVerifiedAt
        // Lido ANTES de gravar: depois da escrita, a senha já é vazio.
        const tinhaSenha = !!doEmail.password
        const dados = confirmado
          ? { googleSub: sub }
          : { googleSub: sub, emailVerifiedAt: new Date(), password: '' }
        await this.prisma.user
          .update({ where: { id: doEmail.id }, data: dados })
          .catch((e: unknown) => {
            if (erroDeUnicidade(e)) {
              throw new ConflictException('Esta conta Google acabou de ser ligada. Tente entrar de novo.')
            }
            throw e
          })
        if (!confirmado) {
          senhaDesligada = tinhaSenha
          // Sem `req`: a sessão DESTA resposta ainda vai ser aberta, e o cookie
          // que ela grava não pode ser apagado junto.
          await this.sessions.encerrarTodas(doEmail.id)
        }
        user = { ...doEmail, ...dados }
        vinculou = true
      }
    }

    if (user) {
      this.conferirSancoes(user)
      const sessao = await this.sessionFor(
        req,
        user.id,
        user.email,
        user.profile?.name || undefined,
        user.profile ? planoVigente(user.profile) : 'free',
        opcoes.lembrar,
        user.termsVersion,
        user.emailVerifiedAt,
        { temSenha: !!user.password, google: true },
      )
      return { etapa: 'sessao', sessao, novaConta: false, vinculou, senhaDesligada }
    }

    const nome = clampText(identidade.nome, NAME_MAX)
    if (!opcoes.aceitouTermos) return { etapa: 'aceite', email, nome }

    const agora = new Date()
    const criado = await this.prisma.user
      .create({
        data: {
          email,
          // Sem senha: nada confere com vazio (user-auth.ts), e o login por senha
          // gasta com ela o mesmo tempo de uma conta que não existe.
          password: '',
          googleSub: sub,
          // O Google confirmou o endereço — google.ts não deixa chegar aqui sem isso.
          emailVerifiedAt: agora,
          // O aceite na MESMA escrita que cria a conta, como no cadastro.
          termsAcceptedAt: agora,
          termsVersion: TERMS_VERSION,
          termsIp: opcoes.ip.slice(0, 60),
          profile: { create: this.starterProfile(nome || undefined) },
        },
        select: { id: true, email: true, profile: { select: { id: true, name: true } } },
      })
      .catch((e: unknown) => {
        // Dois toques em "Criar minha conta": o segundo perde a corrida no índice.
        if (erroDeUnicidade(e)) {
          throw new ConflictException('Esta conta acabou de ser criada. Toque em "Continuar com o Google" de novo para entrar.')
        }
        throw e
      })
    if (criado.profile) await this.resolvePendingInvites(email, criado.profile.id)

    const sessao = await this.sessionFor(
      req,
      criado.id,
      criado.email,
      criado.profile?.name || nome || undefined,
      'free',
      opcoes.lembrar,
      TERMS_VERSION,
      agora,
      { temSenha: false, google: true },
    )
    return { etapa: 'sessao', sessao, novaConta: true, vinculou: false, senhaDesligada: false }
  }

  /**
   * Troca a senha de quem JÁ está dentro — exige a senha atual.
   *
   * Isto NÃO é "esqueci minha senha" (ver pedirRedefinicao, abaixo). Este não
   * precisa de nada além do que a pessoa já tem, e por isso veio antes: era o
   * item 6 de "Em aberto" do SEGURANCA.md, e sem ele quem desconfiava da própria
   * senha não tinha o que fazer.
   *
   * Pedir a senha atual é o que impede que um cookie roubado vire posse da conta:
   * sem essa etapa, quem tivesse a sessão trocaria a senha e trancaria o dono do
   * lado de fora. Com ela, o invasor com o cookie precisa ANTES saber a senha —
   * e se soubesse, não precisaria do cookie.
   *
   * Devolve quantas OUTRAS sessões caíram. Derrubar é o ponto: trocar a senha por
   * desconfiança e deixar o intruso conectado no aparelho dele seria trocar a
   * fechadura deixando a porta dos fundos aberta.
   */
  async trocarSenha(
    req: RequisicaoComAuth,
    userId: string,
    atual?: unknown,
    nova?: unknown,
  ): Promise<{ outrasSessoesEncerradas: number }> {
    const senhaAtual = typeof atual === 'string' ? atual : ''
    const senhaNova = typeof nova === 'string' ? nova : ''

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, password: true },
    })
    if (!user) throw new UnauthorizedException('Entre na sua conta.')
    // Conta criada pelo Google: não há senha atual para conferir, e dizer "não
    // confere" mandaria a pessoa tentar lembrar de uma senha que nunca existiu.
    // O caminho para criar uma é o link por e-mail — que prova o que a senha
    // atual provaria aqui: que quem pede é o dono, e não quem achou o cookie.
    if (!user.password) {
      throw new BadRequestException(
        'Sua conta entra com o Google e ainda não tem senha. Para criar uma, use "Esqueci minha senha" — o link chega no seu e-mail.',
      )
    }
    if (!(await verifyPassword(senhaAtual, user.password))) {
      throw new UnauthorizedException('A senha atual não confere.')
    }

    // A regra de força vale aqui como no cadastro: é senha nova sendo escolhida
    // agora, e não uma antiga que já existe e não pode ser trancada do lado de fora.
    const problema = passwordProblem(senhaNova, user.email)
    if (problema) throw new BadRequestException(problema)
    if (await verifyPassword(senhaNova, user.password)) {
      throw new BadRequestException('A senha nova precisa ser diferente da atual.')
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { password: await hashPassword(senhaNova) },
    })

    // Derruba TUDO e reabre a sessão de quem está trocando. A ordem importa:
    // encerrar primeiro (inclusive a atual, que some junto) e abrir depois deixa
    // esta aba funcionando e todas as outras, não. Se abríssemos antes, a
    // varredura levaria a nova junto e a pessoa seria expulsa da própria troca.
    const encerradas = await this.sessions.encerrarTodas(userId, req)
    await this.sessions.abrir(req, userId, true)
    await this.avisarSenhaAlterada(user.id, user.email, false)

    return { outrasSessoesEncerradas: Math.max(0, encerradas - 1) }
  }

  // ---- E-mail: esqueci a senha e confirmação ---------------------------------

  /**
   * "Esqueci minha senha" — o pedido.
   *
   * Não devolve nada e nunca lança para quem chama: a rota responde a MESMA
   * coisa exista a conta ou não, e dispara isto depois de responder. Assim nem o
   * texto nem o tempo da resposta dizem se o e-mail tem conta aqui.
   *
   * Vale também para conta suspensa ou encerrada. Não devolve acesso (o login
   * continua recusando), e é a senha que abre a contestação de quem não
   * consegue entrar — trancar a redefinição tiraria o canal de recurso de quem
   * esqueceu a senha justamente quando mais precisa dela.
   */
  async pedirRedefinicao(email: unknown): Promise<void> {
    if (!this.correio?.ativo) return
    const mail = this.normalizeEmail(email)
    if (!EMAIL_RE.test(mail)) return
    const user = await this.prisma.user.findUnique({
      where: { email: mail },
      select: { id: true, email: true },
    })
    if (!user) return
    const { token, expiraEm } = await emitirToken(this.prisma, user.id, user.email, 'redefinir')
    await this.correio.enfileirar({
      modelo: 'redefinir-senha',
      para: user.email,
      userId: user.id,
      validoAte: expiraEm,
      dados: { token },
    })
  }

  /**
   * "Esqueci minha senha" — o link usado.
   *
   * O link conferido, a senha nova conferida, e só então o link é gasto: uma
   * senha fraca recusada não pode custar o link, senão a pessoa voltaria à caixa
   * de entrada a cada tentativa.
   *
   * Derruba TODAS as sessões e não abre nenhuma. Quem pede redefinição pode
   * estar fugindo de alguém que está dentro da conta; entrar em seguida, com a
   * senha nova, é um passo a mais que custa pouco a quem é o dono.
   *
   * Redefinir pelo link também confirma o e-mail: é a mesma prova — a pessoa
   * abriu uma mensagem que só chegou naquela caixa.
   */
  async redefinirSenha(req: RequisicaoComAuth, token: unknown, nova: unknown): Promise<{ ok: true }> {
    const invalido = new BadRequestException(
      'Este link não vale mais — ele vence em 1 hora e funciona uma vez só. Peça outro em "Esqueci minha senha".',
    )
    const alvo = await conferirToken(this.prisma, token, 'redefinir')
    if (!alvo) throw invalido
    const user = await this.prisma.user.findUnique({
      where: { id: alvo.userId },
      select: { id: true, email: true, emailVerifiedAt: true },
    })
    // O link foi para um endereço que não é mais o da conta: não vale.
    if (!user || user.email !== alvo.email) throw invalido

    const senhaNova = typeof nova === 'string' ? nova : ''
    const problema = passwordProblem(senhaNova, user.email)
    if (problema) throw new BadRequestException(problema)

    if (!(await gastarToken(this.prisma, alvo.id))) throw invalido
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        password: await hashPassword(senhaNova),
        emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
      },
    })
    await this.sessions.encerrarTodas(user.id, req)
    await this.avisarSenhaAlterada(user.id, user.email, true)
    return { ok: true }
  }

  /**
   * Confirma o e-mail pelo link. Não exige sessão: o link costuma ser aberto no
   * celular, e a conta foi criada no computador.
   */
  async confirmarEmail(token: unknown): Promise<{ ok: true }> {
    const invalido = new BadRequestException(
      'Este link já foi usado ou venceu. Se você já confirmou, não precisa fazer mais nada; ' +
        'senão, entre na sua conta e peça outro pelo painel.',
    )
    const alvo = await conferirToken(this.prisma, token, 'confirmar')
    if (!alvo) throw invalido
    const user = await this.prisma.user.findUnique({
      where: { id: alvo.userId },
      select: { id: true, email: true, emailVerifiedAt: true },
    })
    if (!user || user.email !== alvo.email) throw invalido
    if (!(await gastarToken(this.prisma, alvo.id))) throw invalido
    if (!user.emailVerifiedAt) {
      await this.prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } })
    }
    return { ok: true }
  }

  /** Manda de novo o link de confirmação (o anterior deixa de valer). */
  async reenviarConfirmacao(userId: string): Promise<{ enviado: boolean; jaConfirmado: boolean }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true, profile: { select: { name: true } } },
    })
    if (!user) throw new UnauthorizedException('Entre na sua conta.')
    if (user.emailVerifiedAt) return { enviado: false, jaConfirmado: true }
    if (!this.correio?.ativo) {
      throw new ServiceUnavailableException('O envio de e-mails está desligado no momento. Tente mais tarde.')
    }
    const enviado = await this.enviarConfirmacao(userId, user.email, user.profile?.name || undefined)
    if (!enviado) {
      throw new ServiceUnavailableException('Não foi possível enviar agora. Tente de novo em alguns minutos.')
    }
    return { enviado: true, jaConfirmado: false }
  }

  /** Emite o link e põe na fila. Nunca lança: é consequência, não requisito. */
  private async enviarConfirmacao(userId: string, email: string, nome?: string): Promise<boolean> {
    if (!this.correio?.ativo) return false
    try {
      const { token, expiraEm } = await emitirToken(this.prisma, userId, email, 'confirmar')
      return await this.correio.enfileirar({
        modelo: 'confirmar-email',
        para: email,
        userId,
        validoAte: expiraEm,
        dados: { token, nome: nome ?? '' },
      })
    } catch {
      return false
    }
  }

  /**
   * "Sua senha foi alterada." É o único aviso que chega a quem PERDEU a conta:
   * se foi outra pessoa que trocou, este e-mail é a primeira notícia — e traz o
   * caminho de volta.
   */
  private async avisarSenhaAlterada(userId: string, email: string, porLink: boolean): Promise<void> {
    await this.correio?.enfileirar({
      modelo: 'senha-alterada',
      para: email,
      userId,
      dados: { quando: new Date().toISOString(), porLink },
    })
  }

  async me(userId: string): Promise<AuthSession['user']> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        termsVersion: true,
        emailVerifiedAt: true,
        // Só para dizer à tela SE há senha e SE há Google — os valores não saem daqui.
        password: true,
        googleSub: true,
        // Vigente, não contratado — mesma razão do login: este é o retrato que a
        // tela consulta ANTES de o perfil chegar (ver frontend lib/auth.ts).
        profile: {
          select: {
            name: true,
            plan: true,
            planStatus: true,
            currentPeriodEnd: true,
            graceUntil: true,
          },
        },
      },
    })
    if (!user) throw new UnauthorizedException('Sessão inválida.')
    return {
      id: user.id,
      email: user.email,
      name: user.profile?.name || undefined,
      plan: user.profile ? planoVigente(user.profile) : 'free',
      termsVersion: user.termsVersion,
      termsPending: !aceiteVigente(user.termsVersion),
      emailPending: !user.emailVerifiedAt && this.correioAtivo,
      temSenha: !!user.password,
      google: !!user.googleSub,
    }
  }
}
