import { Controller, Get } from '@nestjs/common'

// Health check SEM banco — o Render usa esta rota para decidir se a API está
// saudável. Não toca no Postgres, então a API é considerada no ar mesmo quando
// o banco está fora (ex.: free do Render expirou) e serve /ai/generate normal.
@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok' }
  }
}
