import { Body, Controller, Post } from '@nestjs/common'
import { AiService, type GenerateDto, type GenerateResult } from './ai.service'

@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  // POST /api/ai/generate  → { text, complianceNotes }
  @Post('generate')
  generate(@Body() dto: GenerateDto): Promise<GenerateResult> {
    return this.ai.generate(dto)
  }
}
