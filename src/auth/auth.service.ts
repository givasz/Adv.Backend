import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { POLICY_VERSION } from '../oab/compliance'
import { slugify } from '../plans'
import { hashPassword, issueUserSession, verifyPassword } from './user-auth'

// Formato de e-mail simples (o mesmo do front). A validação forte fica a cargo
// da confirmação de e-mail (fora do escopo do protótipo).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface AuthSession {
  token: string
  expiresAt: number
  user: { id: string; email: string; name?: string; plan: string }
}

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  private normalizeEmail(email?: string): string {
    return (email ?? '').trim().toLowerCase()
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

  private sessionFor(id: string, email: string, name: string | undefined, plan: string): AuthSession {
    const { token, expiresAt } = issueUserSession(id)
    return { token, expiresAt, user: { id, email, name: name || undefined, plan } }
  }

  async signup(email?: string, password?: string, name?: string): Promise<AuthSession> {
    const mail = this.normalizeEmail(email)
    if (!EMAIL_RE.test(mail)) throw new BadRequestException('E-mail inválido.')
    if (!password || password.length < 6) {
      throw new BadRequestException('A senha deve ter ao menos 6 caracteres.')
    }
    const exists = await this.prisma.user.findUnique({ where: { email: mail }, select: { id: true } })
    if (exists) throw new ConflictException('Já existe uma conta com este e-mail.')

    const cleanName = (name ?? '').trim() || undefined
    const user = await this.prisma.user.create({
      data: {
        email: mail,
        password: hashPassword(password),
        profile: { create: this.starterProfile(cleanName) },
      },
      select: { id: true, email: true, profile: { select: { name: true, plan: true } } },
    })
    return this.sessionFor(user.id, user.email, user.profile?.name || cleanName, user.profile?.plan ?? 'free')
  }

  async login(email?: string, password?: string): Promise<AuthSession> {
    const mail = this.normalizeEmail(email)
    const user = await this.prisma.user.findUnique({
      where: { email: mail },
      select: { id: true, email: true, password: true, profile: { select: { name: true, plan: true } } },
    })
    if (!user || !verifyPassword(password ?? '', user.password)) {
      throw new UnauthorizedException('E-mail ou senha incorretos.')
    }
    return this.sessionFor(user.id, user.email, user.profile?.name || undefined, user.profile?.plan ?? 'free')
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
