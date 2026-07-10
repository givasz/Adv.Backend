import { Body, Controller, Get, Headers, Post, UnauthorizedException } from '@nestjs/common'
import { AuthService } from './auth.service'
import { userIdFromHeader } from './user-auth'

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // POST /api/auth/signup  → { email, password, name? }
  @Post('signup')
  signup(@Body() body: { email?: string; password?: string; name?: string }) {
    return this.auth.signup(body.email, body.password, body.name)
  }

  // POST /api/auth/login  → { email, password }
  @Post('login')
  login(@Body() body: { email?: string; password?: string }) {
    return this.auth.login(body.email, body.password)
  }

  // GET /api/auth/me  (Authorization: Bearer <token>)
  @Get('me')
  me(@Headers('authorization') authorization?: string) {
    const userId = userIdFromHeader(authorization)
    if (!userId) throw new UnauthorizedException('Sessão inválida.')
    return this.auth.me(userId)
  }
}
