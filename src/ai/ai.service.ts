import Anthropic from '@anthropic-ai/sdk'
import { Injectable, Logger } from '@nestjs/common'
import { checkCompliance, hasBlockingIssue, POLICY_VERSION } from '../oab/compliance'

// Recursos de IA. Disponibilidade por plano é decidida no FRONTEND (aiFeatures.ts):
//   free    → bio, area
//   pro     → + headline, improve
//   premium → + article  e  "enriquecimento" (usa cidade/áreas, textos mais longos)
export type GenerateKind = 'bio' | 'area' | 'headline' | 'improve' | 'article'

export type Plan = 'free' | 'pro' | 'premium'

export interface GenerateDto {
  kind: GenerateKind
  keywords: string[]
  areaLabel?: string
  name?: string
  /** cidade/UF — enriquece o texto (usado no plano premium) */
  city?: string
  /** áreas de atuação do perfil — dão contexto (usado no plano premium) */
  areas?: string[]
  /** texto atual a ser revisado quando kind === 'improve' */
  currentText?: string
  /** plano do perfil — controla profundidade/tamanho e o enriquecimento */
  plan?: Plan
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
const OAB_SYSTEM = `Você escreve textos para páginas de perfil de advogados brasileiros (bios, descrições de áreas, frases de apresentação e artigos informativos), seguindo estritamente as normas éticas da OAB (Prov. 205/2021) para publicidade.
Tom sóbrio, ético, factual, informativo e acolhedor. Português do Brasil.
NÃO use: promessas ou garantias de resultado; comparações ou superlativos ("o melhor", "nº 1", "referência"); preços, honorários, descontos ou "grátis"; chamadas para contratar ("contrate agora", "clique aqui"); apelos de urgência; depoimentos ou nomes de clientes; selos, logotipos ou símbolos oficiais da OAB.
Cite apenas qualificações verdadeiras (áreas de atuação, experiência, formação, idiomas, localização).
Não mencione casos concretos, decisões judiciais ou clientes. Responda apenas com o texto final, sem aspas nem comentários.`

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
        ? 'gemini-2.5-flash'
        : 'claude-sonnet-5')

  async generate(dto: GenerateDto): Promise<GenerateResult> {
    const prompt = this.buildPrompt(dto)
    const maxTokens = this.maxTokens(dto)

    // 1ª tentativa. Se produzir termo bloqueante, tenta regenerar uma vez.
    let text = await this.runModel(prompt, maxTokens)
    let usedFallback = false

    if (hasBlockingIssue(text)) {
      this.logger.warn(`Rascunho reprovado no compliance — regenerando: "${text}"`)
      text = await this.runModel(prompt, maxTokens)
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

  // Artigos e textos premium pedem mais espaço; o restante fica enxuto.
  private maxTokens(dto: GenerateDto): number {
    if (dto.kind === 'article') return 700
    if (dto.kind === 'headline') return 60
    return dto.plan === 'premium' ? 500 : 320
  }

  private async runModel(prompt: string, maxTokens: number): Promise<string> {
    try {
      if (this.provider === 'ollama') return await this.viaOllama(prompt, maxTokens)
      if (this.provider === 'gemini') return await this.viaGemini(prompt, maxTokens)
      return await this.viaAnthropic(prompt, maxTokens)
    } catch (err) {
      this.logger.error(`Falha na geração via ${this.provider}`, err as Error)
      throw err
    }
  }

  private list(dto: GenerateDto): string {
    const kw = dto.keywords.map((k) => k.trim()).filter(Boolean)
    if (kw.length > 1) return `${kw.slice(0, -1).join(', ')} e ${kw[kw.length - 1]}`
    return kw[0] ?? (dto.areas?.filter(Boolean).join(', ') || 'sua área de atuação')
  }

  private buildPrompt(dto: GenerateDto): string {
    const kws = dto.keywords.map((k) => k.trim()).filter(Boolean).join(', ')
    const premium = dto.plan === 'premium'
    // Contexto extra só no premium (enriquecimento): cidade e áreas do perfil.
    const extra: string[] = []
    if (premium && dto.city) extra.push(`Cidade/UF: ${dto.city}.`)
    if (premium && dto.areas?.filter(Boolean).length) {
      extra.push(`Áreas do perfil: ${dto.areas.filter(Boolean).join(', ')}.`)
    }
    const ctx = extra.length ? ` Contexto: ${extra.join(' ')}` : ''
    const sentences = premium ? 'No máximo 4 frases' : 'No máximo 3 frases'

    switch (dto.kind) {
      case 'area':
        return `Escreva a descrição da área de atuação "${dto.areaLabel ?? ''}"${
          kws ? ` abordando estes temas: ${kws}` : ''
        }. Explique de forma clara e factual o que o(a) advogado(a) faz nessa área.${ctx} ${sentences}, sem emojis.`

      case 'headline':
        return `Escreva UMA frase de apresentação curta (headline) para o perfil${
          dto.name ? ` de ${dto.name}` : ''
        }, indicando a atuação${
          kws ? ` em: ${kws}` : dto.areas?.length ? ` em: ${dto.areas.filter(Boolean).join(', ')}` : ''
        }. Máximo de 8 palavras, factual e sóbria, sem ponto final. Exemplo de estilo: "Advogada · Direito de Família e Sucessões". Responda apenas a frase.`

      case 'improve':
        return `Revise e reescreva o texto abaixo para ficar mais claro, sóbrio e dentro das normas da OAB, preservando o sentido e os fatos. Não invente qualificações nem dados.${ctx} ${sentences}, sem emojis.\n\nTexto:\n"""${dto.currentText ?? ''}"""`

      case 'article':
        return `Sugira um rascunho de artigo informativo e educativo para o perfil de um(a) advogado(a)${
          dto.areaLabel ? ` na área de ${dto.areaLabel}` : dto.areas?.length ? ` sobre ${dto.areas.filter(Boolean).join(', ')}` : ''
        }${kws ? `, abordando: ${kws}` : ''}. Formato: um título curto na PRIMEIRA linha; em seguida 2 a 3 parágrafos curtos explicando o tema e os direitos envolvidos, em tom educativo. Sem promessas, sem captação, sem citar casos ou clientes.`

      case 'bio':
      default: {
        const who = dto.name ? `de ${dto.name}, que é advogado(a) no Brasil` : 'de um(a) advogado(a) brasileiro(a)'
        return `Escreva, em primeira pessoa, a bio de apresentação ${who}. Atua em: ${this.list(dto)}.${ctx} ${sentences}, sem emojis.`
      }
    }
  }

  // Template garantidamente compliant, usado quando a IA não produz texto aprovado.
  private safeTemplate(dto: GenerateDto): string {
    const list = this.list(dto)
    switch (dto.kind) {
      case 'area': {
        const area = dto.areaLabel ?? 'esta área'
        return `Atuação em ${area}, com foco em ${list}. O trabalho é orientar sobre direitos e alternativas em cada etapa, de forma clara e informativa.`
      }
      case 'headline': {
        const area = dto.areaLabel || dto.areas?.filter(Boolean)[0] || dto.keywords.filter(Boolean)[0] || 'Direito'
        return `Advogado(a) · ${area}`
      }
      case 'improve':
        return dto.currentText?.trim()
          ? dto.currentText.trim()
          : `Advogado(a) inscrito(a) na OAB, com atuação em ${list}. O trabalho é conduzido de forma técnica e informativa, orientando cada pessoa sobre seus direitos e caminhos possíveis.`
      case 'article': {
        const area = dto.areaLabel || dto.areas?.filter(Boolean)[0] || 'o tema'
        return `Entenda melhor: ${area}\n\nEste texto explica, de forma geral e informativa, conceitos e direitos relacionados a ${area}. O objetivo é orientar o leitor sobre como o tema funciona e quais caminhos existem, sem substituir a análise de um caso concreto.`
      }
      case 'bio':
      default: {
        const who = dto.name ? `${dto.name} é advogado(a) inscrito(a) na OAB` : 'Advogado(a) inscrito(a) na OAB'
        return `${who}, com atuação em ${list}. O trabalho é conduzido de forma técnica e informativa, orientando cada pessoa sobre seus direitos e os caminhos possíveis, sempre observando a ética profissional.`
      }
    }
  }

  private async viaAnthropic(prompt: string, maxTokens: number): Promise<string> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
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
  private async viaGemini(prompt: string, maxTokens: number): Promise<string> {
    const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
    if (!key) throw new Error('GEMINI_API_KEY não configurada')
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${key}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: OAB_SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: maxTokens },
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

  private async viaOllama(prompt: string, maxTokens: number): Promise<string> {
    const base = process.env.OLLAMA_URL ?? 'http://localhost:11434'
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        options: { temperature: 0.7, num_predict: maxTokens },
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
}
