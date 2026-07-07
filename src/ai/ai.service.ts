import Anthropic from '@anthropic-ai/sdk'
import { Injectable, Logger } from '@nestjs/common'
import { checkCompliance, hasBlockingIssue, POLICY_VERSION } from '../oab/compliance'

export type GenerateKind = 'bio' | 'area'

export interface GenerateDto {
  kind: GenerateKind
  keywords: string[]
  areaLabel?: string
  name?: string
}

export interface GenerateResult {
  text: string
  complianceNotes: string[]
  /** true se o texto veio do template seguro (IA reprovada no check pós-geração) */
  usedFallback?: boolean
  /** versão da política de publicidade aplicada na verificação */
  policyVersion?: string
}

// Regras da OAB (Prov. 205/2021) em enquadramento positivo — instruir o tom em vez de
// listar proibições evita recusas de modelos menores e produz texto mais natural.
const OAB_SYSTEM = `Você escreve bios e descrições de áreas para páginas de perfil de advogados brasileiros, seguindo estritamente as normas éticas da OAB (Prov. 205/2021) para publicidade.
Tom sóbrio, ético, factual, informativo e acolhedor. Português do Brasil.
NÃO use: promessas ou garantias de resultado; comparações ou superlativos ("o melhor", "nº 1", "referência"); preços, honorários, descontos ou "grátis"; chamadas para contratar ("contrate agora", "clique aqui"); apelos de urgência; depoimentos ou nomes de clientes; selos, logotipos ou símbolos oficiais da OAB.
Cite apenas qualificações verdadeiras (áreas de atuação, experiência, formação, idiomas, localização).
Não mencione casos concretos, decisões judiciais ou clientes. Máximo de 3 frases. Responda apenas com o texto final, sem aspas nem comentários.`

// AI_PROVIDER escolhe o motor de IA:
//   'ollama'    → LLM local (dev, sem custo/API key)
//   'gemini'    → Google Gemini (tier grátis; GEMINI_API_KEY em aistudio.google.com/app/apikey)
//   'anthropic' → Claude (pago; ANTHROPIC_API_KEY) — padrão
type Provider = 'ollama' | 'anthropic' | 'gemini'

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name)
  private readonly provider: Provider =
    process.env.AI_PROVIDER === 'ollama'
      ? 'ollama'
      : process.env.AI_PROVIDER === 'gemini'
        ? 'gemini'
        : 'anthropic'
  private readonly client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  private readonly model =
    process.env.AI_MODEL ??
    (this.provider === 'ollama'
      ? 'llama3.2:3b'
      : this.provider === 'gemini'
        ? 'gemini-2.0-flash'
        : 'claude-sonnet-5')

  async generate(dto: GenerateDto): Promise<GenerateResult> {
    const prompt = this.buildPrompt(dto)

    // 1ª tentativa. Se produzir termo bloqueante, tenta regenerar uma vez.
    let text = await this.runModel(prompt)
    let usedFallback = false

    if (hasBlockingIssue(text)) {
      this.logger.warn(`Rascunho reprovado no compliance — regenerando: "${text}"`)
      text = await this.runModel(prompt)
    }

    // Guarda-corpo pós-geração (fonte da verdade): se ainda escorregar, NÃO devolvemos
    // texto irregular — caímos no template seguro OAB-compliant. Ver REGRAS.md.
    if (hasBlockingIssue(text)) {
      this.logger.warn('IA reprovada após retry — usando template seguro.')
      text = this.safeTemplate(dto)
      usedFallback = true
    }

    return {
      text,
      complianceNotes: checkCompliance(text).map((i) => i.reason),
      usedFallback,
      policyVersion: POLICY_VERSION,
    }
  }

  private async runModel(prompt: string): Promise<string> {
    try {
      if (this.provider === 'ollama') return await this.viaOllama(prompt)
      if (this.provider === 'gemini') return await this.viaGemini(prompt)
      return await this.viaAnthropic(prompt)
    } catch (err) {
      this.logger.error(`Falha na geração via ${this.provider}`, err as Error)
      throw err
    }
  }

  // Template garantidamente compliant, usado quando a IA não produz texto aprovado.
  // Enunciado apenas com termos permitidos (áreas, experiência), sem menções vedadas.
  private safeTemplate(dto: GenerateDto): string {
    const kw = dto.keywords.map((k) => k.trim()).filter(Boolean)
    const list =
      kw.length > 1 ? `${kw.slice(0, -1).join(', ')} e ${kw[kw.length - 1]}` : kw[0] ?? 'sua área'
    if (dto.kind === 'area') {
      const area = dto.areaLabel ?? 'esta área'
      return `Atuação em ${area}, com foco em ${list}. O trabalho é orientar sobre direitos e alternativas em cada etapa, de forma clara e informativa.`
    }
    const who = dto.name ? `${dto.name} é advogado(a) inscrito(a) na OAB` : 'Advogado(a) inscrito(a) na OAB'
    return `${who}, com atuação em ${list}. O trabalho é conduzido de forma técnica e informativa, orientando cada pessoa sobre seus direitos e os caminhos possíveis, sempre observando a ética profissional.`
  }

  private async viaAnthropic(prompt: string): Promise<string> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 400,
      system: OAB_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    })
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
  }

  // Google Gemini via REST (sem SDK). Chave grátis em aistudio.google.com/app/apikey.
  private async viaGemini(prompt: string): Promise<string> {
    const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
    if (!key) throw new Error('GEMINI_API_KEY não configurada')
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${key}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: OAB_SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 400 },
      }),
    })
    if (!res.ok) throw new Error(`Gemini respondeu ${res.status}`)
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[]
    }
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
    return text.replace(/^["“']|["”']$/g, '').trim()
  }

  private async viaOllama(prompt: string): Promise<string> {
    const base = process.env.OLLAMA_URL ?? 'http://localhost:11434'
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        options: { temperature: 0.7, num_predict: 260 },
        messages: [
          { role: 'system', content: OAB_SYSTEM },
          { role: 'user', content: prompt },
        ],
      }),
    })
    if (!res.ok) throw new Error(`Ollama respondeu ${res.status}`)
    const data = (await res.json()) as { message?: { content?: string } }
    return (data.message?.content ?? '').replace(/^["“']|["”']$/g, '').trim()
  }

  private buildPrompt(dto: GenerateDto): string {
    const kws = dto.keywords.map((k) => k.trim()).filter(Boolean).join(', ')
    if (dto.kind === 'area') {
      return `Escreva a descrição da área de atuação "${dto.areaLabel}" com base nestas palavras-chave: ${kws}. Explique de forma clara o que o(a) advogado(a) faz nessa área.`
    }
    const who = dto.name ? `O(a) advogado(a) se chama ${dto.name}. ` : ''
    return `${who}Escreva uma bio de apresentação com base nestas palavras-chave: ${kws}.`
  }
}
