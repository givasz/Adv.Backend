import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { POLICY_VERSION } from '../oab/compliance'
import { slugify } from '../plans'
import { burnPasswordTime, hashPassword, verifyPassword } from './user-auth'
import { SessionService } from './session.service'
import type { RequisicaoComAuth } from './session-context'
import { passwordProblem } from '../password'
import { clampText, EMAIL_MAX } from '../security/sanitize'
import { NAME_MAX } from '../plans'

// Formato de e-mail simples (o mesmo do front). A validação forte fica a cargo
// da confirmação de e-mail (fora do escopo do protótipo).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface AuthSession {
  /** epoch ms do vencimento da sessão (informativo — quem manda é o cookie). */
  expiresAt: number
  /** Token anti-CSRF desta sessão, devolvido no cabeçalho das escritas. */
  csrfToken: string
  remember: boolean
  user: { id: string; email: string; name?: string; plan: string }
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
  ): Promise<AuthSession> {
    const { expiresAt, csrfToken, remember } = await this.sessions.abrir(req, id, lembrar)
    return { expiresAt, csrfToken, remember, user: { id, email, name: name || undefined, plan } }
  }

  async signup(
    req: RequisicaoComAuth,
    email?: unknown,
    password?: unknown,
    name?: unknown,
    lembrar = true,
  ): Promise<AuthSession> {
    const mail = this.normalizeEmail(email)
    if (!EMAIL_RE.test(mail)) throw new BadRequestException('E-mail inválido.')
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
        password: hashPassword(senha),
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
      user.profile?.plan ?? 'free',
      lembrar,
    )
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
        profile: { select: { name: true, plan: true } },
      },
    })
    // E-mail inexistente também paga o preço de uma verificação de senha: sem
    // isso, a diferença de tempo entre "não existe" e "senha errada" entrega quais
    // e-mails têm conta aqui. A mensagem já era única; o tempo agora também é.
    if (!user) {
      burnPasswordTime(senha)
      throw new UnauthorizedException('E-mail ou senha incorretos.')
    }
    if (!verifyPassword(senha, user.password)) {
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
      user.profile?.plan ?? 'free',
      lembrar,
    )
  }

  async me(userId: string): Promise<AuthSession['user']> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, profile: { select: { name: true, plan: true } } },
    })
    if (!user) throw new UnauthorizedException('Sessão inválida.')
    return {
      id: user.id,
      email: user.email,
      name: user.profile?.name || undefined,
      plan: user.profile?.plan ?? 'free',
    }
  }
}
