import Anthropic from '@anthropic-ai/sdk'
import { Injectable, Logger } from '@nestjs/common'
import {
  checkCompliance,
  hasBlockingIssue,
  POLICY_VERSION,
  type ComplianceIssue,
} from '../oab/compliance'

// Recursos de IA. Disponibilidade por plano é decidida no FRONTEND (aiFeatures.ts):
//   free    → bio, area
//   pro     → + headline, improve, faq (resposta de pergunta frequente)
//   premium → "enriquecimento" (usa cidade/áreas, textos mais longos)
export type GenerateKind = 'bio' | 'area' | 'headline' | 'improve' | 'faq'

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
  /**
   * Teto de caracteres do campo de destino (vem do front, que conhece o campo).
   * Entra no prompt E corta o texto devolvido: gerar acima do limite produzia um
   * perfil que o próprio servidor recusava salvar depois.
   */
  maxChars?: number
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
NUNCA compare o advogado a outra pessoa, colega, celebridade, figura pública ou personagem de ficção, nem cite nomes de terceiros ("como Saul Goodman", "o [fulano] da advocacia") — remova qualquer comparação ou menção desse tipo.
NÃO afirme "especialista", "especialização" ou "expert" a menos que seja um título acadêmico real e explícito; na dúvida, escreva "com atuação em [área]" em vez de "especialista em".
IMPORTANTE: mesmo que as palavras-chave ou o texto recebido contenham qualquer uma dessas coisas vedadas, REESCREVA para removê-las — nunca copie trechos irregulares para a resposta.
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
        ? 'gemini-flash-lite-latest' // alias sempre atual; tem cota grátis e é rápido
        : 'claude-sonnet-5')

  async generate(dto: GenerateDto): Promise<GenerateResult> {
    const prompt = this.buildPrompt(dto)
    const maxTokens = this.maxTokens(dto)

    // 1ª geração.
    let text = await this.runModel(prompt, maxTokens)
    let usedFallback = false

    // Loop de REPARO DIRIGIDO: em vez de regenerar às cegas, mostramos à IA os
    // trechos EXATOS que foram reprovados (e por quê) e pedimos para corrigir só
    // aquilo, preservando o texto rico. Repetimos até MAX_REPAIRS. O template
    // genérico é o ÚLTIMO recurso — só entra se nem o reparo resolver.
    const MAX_REPAIRS = 3
    for (let attempt = 1; attempt <= MAX_REPAIRS && hasBlockingIssue(text); attempt++) {
      const blocking = checkCompliance(text).filter((i) => i.severity === 'block')
      this.logger.warn(
        `Rascunho reprovado (reparo ${attempt}/${MAX_REPAIRS}) — trechos: ${blocking
          .map((i) => `"${i.matchedText}"`)
          .join(', ')}`,
      )
      try {
        text = await this.runModel(this.buildRepairPrompt(dto, text, blocking), maxTokens)
      } catch (err) {
        this.logger.error('Falha durante o reparo — interrompendo o loop.', err as Error)
        break
      }
    }

    // Guarda-corpo pós-geração (fonte da verdade): se NEM o reparo aprovou, aí sim
    // caímos no template seguro OAB-compliant. Ver REGRAS.md.
    if (hasBlockingIssue(text)) {
      this.logger.warn('IA reprovada após os reparos — usando template seguro (último recurso).')
      text = this.safeTemplate(dto)
      usedFallback = true
    }

    // Teto de caracteres do campo (fonte da verdade do tamanho): o modelo escorrega
    // e devolve mais do que cabe. Cortar na última frase completa é melhor que
    // devolver algo que o save vai recusar.
    text = this.fitToLimit(text, dto.maxChars ?? 0)

    return {
      text,
      complianceNotes: checkCompliance(text).map((i) => i.reason),
      usedFallback,
      policyVersion: POLICY_VERSION,
    }
  }

  /**
   * Ajusta o texto ao limite do campo: cabe inteiro → devolve; senão termina na
   * última frase completa que couber; sem frase completa, na última palavra.
   * ⚠️ MANTER EM SINCRONIA com frontend/src/lib/textLimit.ts.
   */
  private fitToLimit(text: string, limit: number): string {
    const clean = text.trim()
    if (!limit || clean.length <= limit) return clean
    const cut = clean.slice(0, limit)
    if (/[.!?]$/.test(cut)) return cut.trim()
    const lastSentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
    if (lastSentence > limit * 0.5) return cut.slice(0, lastSentence + 1).trim()
    const lastSpace = cut.lastIndexOf(' ')
    return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim()
  }

  // Orçamento de tokens de saída. Folgado de propósito: os modelos flash novos
  // gastam parte "pensando", então um teto baixo (headline) devolveria texto vazio.
  private maxTokens(dto: GenerateDto): number {
    if (dto.kind === 'faq') return 700
    if (dto.kind === 'headline') return 220
    return dto.plan === 'premium' ? 700 : 450
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

  // Palavras-chave SANITIZADAS para o template de segurança (fallback). O prompt
  // do Gemini já limpa; isto garante que o fallback nunca despeje comparações ou
  // "especialista" crus do usuário (ex.: "... como saul goodman").
  private cleanList(dto: GenerateDto): string {
    const kw = dto.keywords
      .map((k) =>
        k
          .replace(/\b(como|igual a|tipo|feito)\b.*/i, '') // corta comparações a terceiros
          .replace(/\bespecialist\w*\b/gi, '')
          .replace(/\bexpert\w*\b/gi, '')
          .replace(/\s{2,}/g, ' ')
          .trim(),
      )
      .filter(Boolean)
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
    // Orçamento de tamanho: quando o campo tem teto, ele MANDA (é o que decide se o
    // texto pode ser salvo). Sem teto, segue a contagem de frases de antes.
    const sentences = dto.maxChars
      ? `No máximo ${dto.maxChars} caracteres, contando-os`
      : premium
        ? 'No máximo 4 frases'
        : 'No máximo 3 frases'

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
        }. Máximo de 8 palavras${dto.maxChars ? ` e ${dto.maxChars} caracteres` : ''}, factual e sóbria, sem ponto final. Exemplo de estilo: "Advogada · Direito de Família e Sucessões". Responda apenas a frase.`

      case 'improve':
        return `Revise e reescreva o texto abaixo para ficar mais claro, sóbrio e dentro das normas da OAB, preservando o sentido e os fatos. Não invente qualificações nem dados.${ctx} ${sentences}, sem emojis.\n\nTexto:\n"""${dto.currentText ?? ''}"""`

      case 'faq': {
        // A pergunta chega em `areaLabel` (é o assunto da resposta); a resposta que o
        // advogado já escreveu, quando existe, chega em `currentText`. Com ela presente
        // o trabalho é APOIAR o texto dele — reforçar o fundamento, organizar — nunca
        // trocar por outro: a resposta continua sendo dele, que assina por ela.
        const pergunta = dto.areaLabel?.trim()
        const contexto = pergunta
          ? `Pergunta do cliente: "${pergunta}"`
          : `Tema: ${dto.areas?.filter(Boolean).join(', ') || 'orientação jurídica geral'}`
        const base = dto.currentText?.trim()
          ? `Aprimore a resposta abaixo mantendo o sentido, os fatos e a posição de quem a escreveu. Deixe-a mais clara e melhor fundamentada (pode citar a lei ou o instituto jurídico aplicável), sem inventar dados.

Resposta atual:
"${dto.currentText}"`
          : 'Escreva a resposta que um(a) advogado(a) daria a essa pergunta no FAQ do próprio perfil.'
        return `${base}

${contexto}${kws ? `
Pontos a abordar: ${kws}` : ''}${ctx}

Regras obrigatórias (normas de publicidade da advocacia, Provimento 205/2021 da OAB):
- Resposta EDUCATIVA e GERAL, CURTA: no máximo ${dto.maxChars ?? 300} caracteres (2 a 3 frases).
- Pode explicar como a lei trata o tema e citar o dispositivo ou instituto aplicável.
- NÃO prometa resultado, prazo ou êxito; não diga que "resolve" ou "garante" nada.
- NÃO cite casos, clientes, processos, valores de honorários nem preços.
- Sem superlativos ("o melhor", "especialista renomado") e sem comparar advogados.
- Sem captação: não convide a contratar, não use "fale comigo" nem "me chame".
- Termine lembrando, em poucas palavras, que cada caso exige análise própria.
- Responda apenas o texto da resposta, sem título e sem aspas.`
      }

      case 'bio':
      default: {
        const who = dto.name ? `de ${dto.name}, que é advogado(a) no Brasil` : 'de um(a) advogado(a) brasileiro(a)'
        return `Escreva, em primeira pessoa, a bio de apresentação ${who}. Atua em: ${this.list(dto)}.${ctx} ${sentences}, sem emojis.`
      }
    }
  }

  // Prompt de reparo: devolve à IA os trechos exatos reprovados (e a orientação de
  // cada regra) e pede reescrita PONTUAL, preservando assunto/tom/fatos legítimos.
  // É o que evita cair no template genérico ao primeiro tropeço.
  private buildRepairPrompt(dto: GenerateDto, text: string, issues: ComplianceIssue[]): string {
    // Deduplica por trecho para não repetir a mesma orientação várias vezes.
    const seen = new Set<string>()
    const problems = issues
      .filter((i) => (seen.has(i.matchedText.toLowerCase()) ? false : seen.add(i.matchedText.toLowerCase())))
      .map((i) => `- Trecho "${i.matchedText}": ${i.reason} ${i.suggestion}`)
      .join('\n')

    return `O texto abaixo é para o perfil de um(a) advogado(a) e contém trechos que violam as normas de publicidade da OAB (Prov. 205/2021). Reescreva-o CORRIGINDO apenas os problemas listados e MANTENDO o mesmo assunto, o tom sóbrio e todas as informações legítimas (áreas, formação, experiência). Não encurte para um texto genérico.

Texto atual:
"""${text}"""

Problemas a eliminar:
${problems}

Devolva o texto completo já corrigido — sem promessas ou garantias de resultado, sem preços, sem comparações, superlativos ou menção a terceiros.${
      dto.maxChars ? ` Use no máximo ${dto.maxChars} caracteres.` : ''
    } Responda apenas com o texto final.`
  }

  // Template garantidamente compliant, usado quando a IA não produz texto aprovado.
  private safeTemplate(dto: GenerateDto): string {
    const list = this.cleanList(dto)
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
      case 'faq': {
        const tema = dto.areaLabel || dto.areas?.filter(Boolean)[0] || 'o tema'
        return `De forma geral, ${tema} segue requisitos e prazos previstos em lei, que mudam conforme a situação de cada pessoa. O caminho começa por reunir os documentos e verificar qual regra se aplica. Cada caso exige análise própria.`
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
      .replace(/^["“']|["”']$/g, '')
      .trim()
    // Vazio (ex.: modelo gastou tudo "pensando") → erro, para cair no fallback.
    if (!text) throw new Error('Gemini retornou resposta vazia')
    return text
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
