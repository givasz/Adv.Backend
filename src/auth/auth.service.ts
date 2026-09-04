import {
  BadRequestException,
  ConflictException,
  Injectable,
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

// Formato de e-mail simples (o mesmo do front). A validação forte fica a cargo
// da confirmação de e-mail (fora do escopo do protótipo).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

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
  }
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
  ) {}

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
    return this.sessionFor(
      req,
      user.id,
      user.email,
      user.profile?.name || cleanName,
      user.profile ? planoVigente(user.profile) : 'free',
      lembrar,
      TERMS_VERSION,
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
    // E-mail inexistente também paga o preço de uma verificação de senha: sem
    // isso, a diferença de tempo entre "não existe" e "senha errada" entrega quais
    // e-mails têm conta aqui. A mensagem já era única; o tempo agora também é.
    if (!user) {
      await burnPasswordTime(senha)
      throw new UnauthorizedException('E-mail ou senha incorretos.')
    }
    if (!(await verifyPassword(senha, user.password))) {
      throw new UnauthorizedException('E-mail ou senha incorretos.')
    }

    // Sanções que alcançam a CONTA (degraus 4 e 5 de docs/politica-de-sancoes.md).
    // A checagem vem DEPOIS da senha de propósito: quem erra a senha continua
    // recebendo a mesma resposta de sempre, e só quem prova ser o dono da conta
    // descobre que ela foi suspensa — e por quê. Dizer antes transformaria o
    // login numa consulta pública de quem foi sancionado.
    //
    // A mensagem traz o MOTIVO escrito pelo administrador. É o mesmo texto do
    // registro: uma sanção que a pessoa não consegue ler é uma sanção que ela
    // não tem como contestar.
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

    return this.sessionFor(
      req,
      user.id,
      user.email,
      user.profile?.name || undefined,
      user.profile ? planoVigente(user.profile) : 'free',
      lembrar,
      user.termsVersion,
    )
  }

  /**
   * Troca a senha de quem JÁ está dentro — exige a senha atual.
   *
   * Isto NÃO é "esqueci minha senha": aquele fluxo precisa de e-mail, que a
   * plataforma ainda não envia. Este não precisa de nada além do que a pessoa já
   * tem, e por isso pôde vir antes: era o item 6 de "Em aberto" do SEGURANCA.md,
   * e sem ele quem desconfiava da própria senha não tinha o que fazer.
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

    return { outrasSessoesEncerradas: Math.max(0, encerradas - 1) }
  }
  async me(userId: string): Promise<AuthSession['user']> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        termsVersion: true,
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
    }
  }
}
