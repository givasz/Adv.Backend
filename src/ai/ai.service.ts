import Anthropic from '@anthropic-ai/sdk'
import { Injectable, Logger } from '@nestjs/common'
import {
  checkCompliance,
  hasBlockingIssue,
  POLICY_VERSION,
  type ComplianceIssue,
} from '../oab/compliance'
import { clampList, clampText } from '../security/sanitize'
import {
  cadeiaUtil,
  chaveQueimada,
  Descanso,
  DESCANSO_LENTO_MS,
  DESCANSO_MS,
  ErroDeProvedor,
  GiroDeChaves,
  lerChaves,
  MINIMO_PARA_TENTAR_MS,
  modeloDe,
  PAUSA_ANTES_DE_REPETIR_MS,
  PRAZO_DO_PEDIDO_MS,
  PROVEDORES,
  restante,
  TEMPO_POR_CHAMADA_MS,
  tempoEsgotou,
  valeRepetir,
  type Provider,
} from './provedores'
import { fatosNaoInformados, pareceFato } from './fatos'
// O teto do FAQ entra no PROMPT. Antes era o número 300 escrito à mão aqui: se
// alguém baixasse a constante (como aconteceu, para 220), a IA continuaria sendo
// instruída a escrever até 300 e o texto voltaria cortado no meio da frase.
//
// ⚠️ Use `||` e não `??` ao ler `dto.maxChars`: ausente ele vale ZERO (ver a
// normalização em `toDto`), e `0 ?? 220` devolve 0 — o prompt mandaria a IA
// escrever "no máximo 0 caracteres".
import { FAQ_ANSWER_MAX } from '../plans'

// Tetos do que entra no prompt. Duas razões, nesta ordem: o prompt é enviado a um
// provedor que cobra por token (texto sem limite é conta sem limite), e um campo
// que devia ser uma lista chegando como número derrubaria a rota com 500.
const KEYWORDS_MAX = 12
const KEYWORD_CHARS = 80
const CURRENT_TEXT_MAX = 2000
const AREA_LABEL_MAX = 120
const NAME_CHARS = 70
const CITY_CHARS = 80
const AREAS_MAX = 20
const MAXCHARS_TETO = 1200
const KINDS = ['bio', 'area', 'headline', 'improve', 'faq'] as const

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

/** O que o reparo precisa saber de cada trecho reprovado — vedação da OAB ou fato não informado. */
type ProblemaDoRascunho = Pick<ComplianceIssue, 'matchedText' | 'reason' | 'suggestion'>

export interface GenerateResult {
  text: string
  complianceNotes: string[]
  /** true se o texto veio do template seguro (IA reprovada no check pós-geração) */
  usedFallback?: boolean
  /** Gerações que ainda cabem nas 24 h de quem pediu — preenchido pelo controller. */
  limite?: { restantesHoje: number; tetoHoje: number }
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
Use SOMENTE os fatos que vierem no pedido. NUNCA acrescente formação, faculdade ou universidade, pós-graduação, especialização, mestrado, doutorado, tempo de experiência, seccional ou número da OAB, cargos, títulos, prêmios, cidade ou áreas que não tenham sido informados. Com poucos dados, escreva um texto mais curto e geral sobre a atuação — nunca complete com suposições.
Não mencione casos concretos, decisões judiciais ou clientes. Responda apenas com o texto final, sem aspas nem comentários.`

// A mesma regra, repetida no fim de cada pedido que fala da pessoa. Modelo menor
// segue melhor o que vem por último na mensagem do que o que ficou no sistema.
//
// Medido em 12/09/2026: sem ela, o gpt-oss-120b escreveu "formada pela Universidade
// Estadual de Campinas" e "pós-graduação em Direito do Trabalho" para quem só tinha
// informado "PUC-Campinas". A instrução reduz; quem garante é fatos.ts, que confere
// o rascunho e manda ao reparo o que foi inventado.
const SO_FATOS_INFORMADOS =
  'Use SOMENTE os dados deste pedido: não acrescente formação, faculdade, pós-graduação, especialização, mestrado, doutorado, tempo de experiência, seccional ou número da OAB, cargos, prêmios, cidade ou áreas que não foram informados. Com poucos dados, escreva menos — nunca complete com suposições.'

// O texto-modelo quando nem o pedido tem nada aproveitável: nada do que a pessoa
// digitou entra aqui, e por isso ele passa na checagem por construção (há teste).
const TEMPLATE_NEUTRO: Record<GenerateKind, string> = {
  bio: 'Advogado(a) inscrito(a) na OAB. O trabalho é conduzido de forma técnica e informativa, orientando cada pessoa sobre seus direitos e os caminhos possíveis, sempre observando a ética profissional.',
  improve:
    'Advogado(a) inscrito(a) na OAB. O trabalho é conduzido de forma técnica e informativa, orientando cada pessoa sobre seus direitos e os caminhos possíveis.',
  area: 'Atuação nesta área com orientação sobre direitos e alternativas em cada etapa, de forma clara e informativa.',
  headline: 'Advogado(a) · Direito',
  faq: 'De forma geral, a resposta depende de requisitos e prazos previstos em lei, que mudam conforme a situação de cada pessoa. O caminho começa por reunir os documentos e verificar qual regra se aplica. Cada caso exige análise própria.',
}

/** "a, b e c". */
function juntar(itens: string[]): string {
  return itens.length > 1 ? `${itens.slice(0, -1).join(', ')} e ${itens[itens.length - 1]}` : (itens[0] ?? '')
}

// Qual motor de IA escreve, e o que acontece quando ele para de responder, vive
// em provedores.ts — inclusive a leitura de `AI_PROVIDER` (que hoje aceita uma
// CADEIA: "gemini,groq,openrouter") e das chaves de reserva.

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name)
  private readonly giro = new GiroDeChaves()
  private readonly descanso = new Descanso()
  /** A espera antes de repetir. Pública e substituível: teste nenhum quer dormir 800 ms. */
  pausa: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))

  async generate(entrada: GenerateDto): Promise<GenerateResult> {
    const dto = this.sanitizeDto(entrada)
    const prompt = this.buildPrompt(dto)
    const maxTokens = this.maxTokens(dto)

    // 1ª geração.
    //
    // A cadeia inteira pode cair — provedor fora do ar, cota estourada em todas
    // as chaves, VPS sem saída para a internet. Isso NÃO pode virar 500: o
    // advogado clicou em "gerar" e o que ele precisa é de um rascunho. O
    // template abaixo é o mesmo usado quando a IA escreve algo irregular, e é
    // garantidamente regular por construção — melhor um texto sóbrio e sem
    // graça do que uma tela de erro.
    // O relógio do pedido inteiro começa aqui (ver PRAZO_DO_PEDIDO_MS): tudo o
    // que vem abaixo — reserva, repetição, reparos — tem de caber nele.
    const prazo = Date.now() + PRAZO_DO_PEDIDO_MS
    let usedFallback = false
    let text: string
    try {
      text = await this.runModel(prompt, maxTokens, prazo)
    } catch (err) {
      this.logger.error('Nenhum provedor da cadeia respondeu — usando o template seguro.', err as Error)
      text = this.safeTemplate(dto)
      usedFallback = true
    }

    // Loop de REPARO DIRIGIDO: em vez de regenerar às cegas, mostramos à IA os
    // trechos EXATOS que foram reprovados (e por quê) e pedimos para corrigir só
    // aquilo, preservando o texto rico. Repetimos até MAX_REPAIRS. O template
    // genérico é o ÚLTIMO recurso — só entra se nem o reparo resolver.
    const MAX_REPAIRS = 3
    for (
      let attempt = 1;
      // `!usedFallback`: com a cadeia caída não há a quem pedir reparo, e o
      // template já é regular. Sem esta condição, um clique com todos os
      // provedores fora esperaria três tempos-limite antes de responder.
      // `restante(prazo)`: um reparo que não terminaria antes do corte do proxy
      // não é reparo — é um erro de gateway. Quem paga o prazo apertado é o
      // reparo (vira template, que já é regular), nunca a resposta.
      !usedFallback &&
      attempt <= MAX_REPAIRS &&
      this.problemas(text, dto).length > 0 &&
      restante(prazo) >= MINIMO_PARA_TENTAR_MS;
      attempt++
    ) {
      const blocking = this.problemas(text, dto)
      this.logger.warn(
        `Rascunho reprovado (reparo ${attempt}/${MAX_REPAIRS}) — trechos: ${blocking
          .map((i) => `"${i.matchedText}"`)
          .join(', ')}`,
      )
      try {
        text = await this.runModel(this.buildRepairPrompt(dto, text, blocking), maxTokens, prazo)
      } catch (err) {
        this.logger.error('Falha durante o reparo — interrompendo o loop.', err as Error)
        break
      }
    }

    // Guarda-corpo pós-geração (fonte da verdade): se NEM o reparo aprovou, aí sim
    // caímos no template seguro OAB-compliant. Ver REGRAS.md.
    if (this.problemas(text, dto).length) {
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
   * Fronteira de entrada da IA: tudo o que vai para o prompt passa por aqui, com
   * tipo conferido e teto de tamanho. O `plan` NÃO é lido do corpo — quem o define
   * é o controller, a partir da assinatura gravada no banco.
   */
  private sanitizeDto(d: any): GenerateDto {
    const kind = (KINDS as readonly string[]).includes(d?.kind) ? d.kind : 'bio'
    const maxChars = Number(d?.maxChars)
    return {
      kind: kind as GenerateKind,
      keywords: clampList<unknown>(d?.keywords, KEYWORDS_MAX)
        .map((k) => clampText(k, KEYWORD_CHARS))
        .filter(Boolean),
      areaLabel: clampText(d?.areaLabel, AREA_LABEL_MAX) || undefined,
      name: clampText(d?.name, NAME_CHARS) || undefined,
      city: clampText(d?.city, CITY_CHARS) || undefined,
      areas: clampList<unknown>(d?.areas, AREAS_MAX)
        .map((a) => clampText(a, AREA_LABEL_MAX))
        .filter(Boolean),
      currentText: clampText(d?.currentText, CURRENT_TEXT_MAX) || undefined,
      plan: d?.plan === 'pro' || d?.plan === 'premium' ? d.plan : 'free',
      maxChars: this.tetoDeCaracteres(maxChars, kind as GenerateKind),
    }
  }

  /**
   * O teto de caracteres que vale para esta geração.
   *
   * O front manda o teto do campo de destino, e é ele que manda quando vem. Mas
   * QUANDO NÃO VEM, o valor caía em 0 — e 0 significa "não corte", então uma
   * resposta de FAQ voltava com o tamanho que o modelo quisesse. Medido aqui:
   * 314 caracteres num campo de 220. O texto passava, e só o `maxLength` do
   * campo na tela impedia o estrago — quem colasse por outro caminho gravaria
   * um texto que o save recusa.
   *
   * O teto do FAQ é fato do SERVIDOR (ver plans.ts), não sugestão do cliente.
   * Um cliente que esquece de declará-lo não deveria conseguir um texto maior do
   * que o campo aceita — a mesma razão pela qual o plano é lido do banco e não
   * do corpo da requisição.
   */
  private tetoDeCaracteres(pedido: number, kind: GenerateKind): number {
    const declarado =
      Number.isFinite(pedido) && pedido > 0 ? Math.min(Math.round(pedido), MAXCHARS_TETO) : 0
    if (declarado > 0) return declarado
    // Campos cujo tamanho o servidor conhece sozinho. Os demais seguem sem teto
    // (0), porque dependem do plano — e o plano do corpo não é confiável.
    //
    // O teto do FAQ virou tabela por plano em 04/09/2026. Aqui vale o MAIOR: este
    // é o caminho de quem não declarou tamanho nenhum, e apertar por conta própria
    // encurtaria a resposta de um Max sem que ninguém tivesse pedido. Quem sabe o
    // plano é o editor, e ele manda o número no pedido (ver Editor.aiLimit).
    return kind === 'faq' ? Math.max(...Object.values(FAQ_ANSWER_MAX)) : 0
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

  /**
   * Pede o texto ao primeiro provedor da cadeia que responder.
   *
   * É um PLANO B, não uma corrida: um provedor por vez, na ordem do `.env`, e
   * o próximo só entra quando o anterior desistiu. Dois laços, e a diferença
   * entre eles é o que faz a coisa funcionar:
   *
   *   • o de FORA passa de provedor em provedor — Gemini caiu, tenta o Groq;
   *   • o de DENTRO troca de CHAVE dentro do mesmo provedor, e só quando o erro
   *     é da chave (cota estourada, chave recusada). Um 500 do Gemini não é
   *     motivo para gastar a chave reserva do Gemini: é motivo para ir ao Groq.
   *
   * E, desde 04/09/2026, duas coisas entre um laço e outro:
   *
   *   • REPETIÇÃO — uma falha passageira (5xx, rede) ganha UMA segunda chance
   *     no mesmo provedor, depois de uma pausa curta. É a "tentativa de
   *     conserto" antes de passar a vez; o tier grátis tropeça e se levanta em
   *     um segundo com frequência;
   *   • DESCANSO — quem falhou de verdade sai da fila por um minuto (três, se
   *     foi tempo esgotado). Os pedidos seguintes vão direto para a reserva em
   *     vez de pagar a mesma falha de novo, e quando o prazo vence o principal
   *     é sondado — e retoma o posto sozinho se tiver voltado.
   *
   * Nada disso aparece para quem clicou. Se a cadeia inteira falhar, o erro do
   * ÚLTIMO provedor sobe — e o `generate()` acima ainda tem o template seguro,
   * então nem uma falha total deixa o advogado sem texto.
   */
  private async runModel(prompt: string, maxTokens: number, prazo: number): Promise<string> {
    const completa = cadeiaUtil(process.env)
    if (!completa.length) {
      throw new Error(
        'Nenhum provedor de IA configurado: confira AI_PROVIDER e a chave do provedor escolhido.',
      )
    }
    const cadeia = this.descanso.filtrar(completa)

    let ultimoErro: unknown
    for (const provedor of cadeia) {
      // "Principal" é o primeiro da cadeia CONFIGURADA, não o primeiro acordado:
      // é ele que AI_MODEL descreve, e é a ausência dele que merece o aviso.
      const principal = provedor === completa[0]
      const chaves = lerChaves(process.env, provedor)
      const modelo = modeloDe(process.env, provedor, principal)
      const total = Math.max(1, chaves.length)

      let tentativa = 1
      let repetiu = false
      while (tentativa <= total) {
        // O orçamento do pedido acabou? Então nem começa: a chamada não
        // terminaria antes do corte do proxy, e o template responde na hora.
        // Não é falha do provedor — ele NÃO descansa por isso.
        if (restante(prazo) < MINIMO_PARA_TENTAR_MS) {
          this.logger.warn(`${provedor}: prazo do pedido esgotado antes de chamar — template.`)
          throw ultimoErro ?? new ErroDeProvedor(provedor, 0, 'prazo do pedido esgotado')
        }
        const chave = this.giro.chave(provedor, chaves)
        try {
          const texto = await this.chamarProvedor(provedor, modelo, chave, prompt, maxTokens, prazo)
          if (!texto) throw new ErroDeProvedor(provedor, 0, 'resposta vazia')
          this.descanso.liberar(provedor)
          if (!principal) {
            // Vale a linha de log: o principal caiu e ninguém percebeu porque a
            // reserva assumiu. Sem isto, a descoberta só viria pela fatura ou
            // pela reclamação de que "a IA está escrevendo diferente".
            this.logger.warn(`Gerado pela reserva ${provedor} (${modelo}) — o principal falhou.`)
          }
          return texto
        } catch (err) {
          ultimoErro = err
          const status = err instanceof ErroDeProvedor ? err.status : 0
          const corpo = err instanceof ErroDeProvedor ? err.message : ''

          if (chaveQueimada(status, corpo)) {
            if (this.giro.girar(provedor, total, tentativa)) {
              this.logger.warn(
                `${provedor}: chave ${this.giro.indice(provedor)} recusada (${status}) — indo para a próxima.`,
              )
              tentativa++
              continue
            }
            // Todas as chaves deste provedor recusadas: ele descansa. A cota
            // diária não volta em um minuto, mas o custo de sondar é um 429
            // rápido — e um limite por minuto (Groq) já terá passado.
            this.descanso.marcar(provedor, DESCANSO_MS)
            this.logger.error(
              `${provedor}: ${total} chave(s) recusada(s) (${status}) — descansa ${DESCANSO_MS / 1000} s; indo para a reserva.`,
            )
            break
          }

          if (
            !repetiu &&
            valeRepetir(status, corpo) &&
            restante(prazo) >= PAUSA_ANTES_DE_REPETIR_MS + MINIMO_PARA_TENTAR_MS
          ) {
            // A "tentativa de conserto": mesma chave, mesmo provedor, uma vez.
            repetiu = true
            this.logger.warn(
              `${provedor}: falha passageira (${status || 'rede'}) — repetindo em ${PAUSA_ANTES_DE_REPETIR_MS} ms.`,
            )
            await this.pausa(PAUSA_ANTES_DE_REPETIR_MS)
            continue
          }

          const descansoMs = tempoEsgotou(status, corpo) ? DESCANSO_LENTO_MS : DESCANSO_MS
          this.descanso.marcar(provedor, descansoMs)
          this.logger.error(
            `Falha na geração via ${provedor} — descansa ${descansoMs / 1000} s; indo para a reserva.`,
            err as Error,
          )
          break
        }
      }
    }
    throw ultimoErro ?? new Error('Nenhum provedor de IA respondeu')
  }

  /** Despacha para o caminho de cada provedor. Os compatíveis com a OpenAI dividem um só. */
  private chamarProvedor(
    provedor: Provider,
    modelo: string,
    chave: string,
    prompt: string,
    maxTokens: number,
    prazo: number,
  ): Promise<string> {
    // O teto desta chamada é o menor entre o teto de uma chamada e o que sobra
    // do pedido: a reserva chamada aos 15 s ganha 7 s, não 12.
    const limiteMs = Math.min(TEMPO_POR_CHAMADA_MS, restante(prazo))
    if (provedor === 'ollama') return this.viaOllama(modelo, prompt, maxTokens, limiteMs)
    if (provedor === 'gemini') return this.viaGemini(modelo, chave, prompt, maxTokens, limiteMs)
    if (provedor === 'anthropic') return this.viaAnthropic(modelo, chave, prompt, maxTokens, limiteMs)
    const base = PROVEDORES[provedor].baseOpenAi!
    return this.viaOpenAiCompativel(provedor, base, modelo, chave, prompt, maxTokens, limiteMs)
  }

  /**
   * Os itens do pedido que o texto-modelo pode escrever.
   *
   * Até 12/09/2026 era só "tira comparação e 'especialista'" — e o resto entrava
   * cru. Medido: palavras-chave "a melhor advogada" e "garanto resultado" viraram
   * "com atuação em a melhor advogada e garanto resultado", devolvido ao editor
   * com duas vedações. Agora o item entra só se passar LIMPO na checagem (nem
   * aviso) e não for currículo ("10 anos", "PUC-Campinas" não são área de atuação).
   */
  private itensSeguros(itens: (string | undefined)[] | undefined): string[] {
    return (itens ?? [])
      .map((k) =>
        (k ?? '')
          .replace(/\b(como|igual a|tipo|feito)\b.*/i, '') // corta comparações a terceiros
          .replace(/\s{2,}/g, ' ')
          .trim(),
      )
      .filter((k) => k && checkCompliance(k).length === 0 && !pareceFato(k))
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
        }. Explique de forma clara e factual o que o(a) advogado(a) faz nessa área.${ctx} ${sentences}, sem emojis. ${SO_FATOS_INFORMADOS}`

      case 'headline':
        return `Escreva UMA frase de apresentação curta (headline) para o perfil${
          dto.name ? ` de ${dto.name}` : ''
        }, indicando a atuação${
          kws ? ` em: ${kws}` : dto.areas?.length ? ` em: ${dto.areas.filter(Boolean).join(', ')}` : ''
        }. Máximo de 8 palavras${dto.maxChars ? ` e ${dto.maxChars} caracteres` : ''}, factual e sóbria, sem ponto final. Exemplo de estilo: "Advogada · Direito de Família e Sucessões". ${SO_FATOS_INFORMADOS} Responda apenas a frase.`

      case 'improve':
        return `Revise e reescreva o texto abaixo para ficar mais claro, sóbrio e dentro das normas da OAB, preservando o sentido e os fatos. Não invente qualificações nem dados. ${SO_FATOS_INFORMADOS}${ctx} ${sentences}, sem emojis.\n\nTexto:\n"""${dto.currentText ?? ''}"""`

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
- Resposta EDUCATIVA e GERAL, CURTA: no máximo ${dto.maxChars || Math.max(...Object.values(FAQ_ANSWER_MAX))} caracteres, em 2 ou 3 frases. Prefira ficar ABAIXO desse teto — o teto é o limite, não a meta.
- Pode explicar como a lei trata o tema e citar o dispositivo ou instituto aplicável.
- NÃO prometa resultado, prazo ou êxito; não diga que "resolve" ou "garante" nada.
- NÃO cite casos, clientes, processos, valores de honorários nem preços.
- Não fale de formação, experiência, cargos ou títulos de quem responde.
- Sem superlativos ("o melhor", "especialista renomado") e sem comparar advogados.
- Sem captação: não convide a contratar, não use "fale comigo" nem "me chame".
- Termine lembrando, em poucas palavras, que cada caso exige análise própria.
- Responda apenas o texto da resposta, sem título e sem aspas.`
      }

      case 'bio':
      default: {
        const who = dto.name ? `de ${dto.name}, que é advogado(a) no Brasil` : 'de um(a) advogado(a) brasileiro(a)'
        // Até 12/09/2026 as palavras-chave entravam como "Atua em: ...": "10 anos,
        // PUC-Campinas" chegava ao modelo como área de atuação, e ele completava o
        // resto. Palavra-chave é o que a pessoa escreveu, e o prompt diz só isso.
        const informado = kws
          ? `O que o(a) advogado(a) informou sobre a atuação: ${kws}.`
          : `Áreas de atuação: ${dto.areas?.filter(Boolean).join(', ') || 'não informadas'}.`
        return `Escreva, em primeira pessoa, a bio de apresentação ${who}. ${informado}${ctx} ${sentences}, sem emojis. ${SO_FATOS_INFORMADOS}`
      }
    }
  }

  /**
   * O que impede um rascunho da IA de voltar: vedação da OAB (block) e fato de
   * currículo que o pedido não trouxe (ver fatos.ts). Os dois vão ao mesmo reparo.
   *
   * O FAQ fica fora da segunda conferência: é texto educativo sobre a lei, e "2
   * anos", "faculdade" ou "perito" ali são assunto, não currículo de quem responde.
   */
  private problemas(text: string, dto: GenerateDto): ProblemaDoRascunho[] {
    const vedacoes = checkCompliance(text).filter((i) => i.severity === 'block')
    if (dto.kind === 'faq') return vedacoes
    return [...vedacoes, ...fatosNaoInformados(text, dto, dto.kind === 'area' ? 'area' : 'perfil')]
  }

  /** Os dados do pedido, para o reparo não trocar uma invenção por outra. Nada além do que o prompt já enviou. */
  private resumoDosDados(dto: GenerateDto): string {
    const premium = dto.plan === 'premium'
    const areas = dto.areas?.filter(Boolean) ?? []
    const partes = [
      dto.name && `nome: ${dto.name}`,
      dto.areaLabel && `${dto.kind === 'faq' ? 'pergunta' : 'área'}: ${dto.areaLabel}`,
      (premium || dto.kind === 'headline') && areas.length && `áreas: ${areas.join(', ')}`,
      premium && dto.city && `cidade: ${dto.city}`,
      dto.keywords.length && `palavras-chave: ${dto.keywords.join(', ')}`,
    ].filter(Boolean)
    return partes.length ? partes.join('; ') : 'nenhum além do próprio texto'
  }

  // Prompt de reparo: devolve à IA os trechos exatos reprovados (e a orientação de
  // cada regra) e pede reescrita PONTUAL, preservando assunto/tom/fatos informados.
  // É o que evita cair no template genérico ao primeiro tropeço.
  private buildRepairPrompt(dto: GenerateDto, text: string, issues: ProblemaDoRascunho[]): string {
    // Deduplica por trecho para não repetir a mesma orientação várias vezes.
    const seen = new Set<string>()
    const problems = issues
      .filter((i) => (seen.has(i.matchedText.toLowerCase()) ? false : seen.add(i.matchedText.toLowerCase())))
      .map((i) => `- Trecho "${i.matchedText}": ${i.reason} ${i.suggestion}`)
      .join('\n')

    return `O texto abaixo é para o perfil de um(a) advogado(a) e contém trechos que violam as normas de publicidade da OAB (Prov. 205/2021). Reescreva-o CORRIGINDO apenas os problemas listados e MANTENDO o mesmo assunto, o tom sóbrio e as informações que constam nos dados informados. Não encurte para um texto genérico.

Dados informados pelo(a) advogado(a): ${this.resumoDosDados(dto)}.

Texto atual:
"""${text}"""

Problemas a eliminar:
${problems}

Devolva o texto completo já corrigido — sem promessas ou garantias de resultado, sem preços, sem comparações, superlativos ou menção a terceiros.${
      dto.maxChars ? ` Use no máximo ${dto.maxChars} caracteres.` : ''
    } ${SO_FATOS_INFORMADOS} Responda apenas com o texto final.`
  }

  /**
   * O texto-modelo: o ÚLTIMO recurso, quando a IA não entrega texto aprovado.
   *
   * A promessa dele é absoluta — nunca devolver texto reprovado —, e é por isso
   * que o generate() pode confiar nele sem conferir de novo. Duas travas:
   *   1. só entra item do pedido que passa limpo (ver itensSeguros);
   *   2. o texto montado é conferido; se ainda assim tiver vedação (um nome como
   *      "Dra. Ana, a número 1"), sai o TEMPLATE_NEUTRO, sem nada do pedido.
   */
  private safeTemplate(dto: GenerateDto): string {
    const texto = this.montarTemplate(dto)
    return hasBlockingIssue(texto) || fatosNaoInformados(texto, dto).length ? TEMPLATE_NEUTRO[dto.kind] : texto
  }

  private montarTemplate(dto: GenerateDto): string {
    const temas = this.itensSeguros(dto.keywords)
    const areas = this.itensSeguros(dto.areas)
    const atuacao = juntar(areas.length ? areas : temas)
    const onde = atuacao ? `, com atuação em ${atuacao}` : ''
    switch (dto.kind) {
      case 'area': {
        const area = this.itensSeguros([dto.areaLabel])[0]
        const foco = juntar(temas)
        return `${area ? `Atuação em ${area}` : 'Atuação nesta área'}${foco ? `, com foco em ${foco}` : ''}. O trabalho é orientar sobre direitos e alternativas em cada etapa, de forma clara e informativa.`
      }
      case 'headline':
        return `Advogado(a) · ${this.itensSeguros([dto.areaLabel])[0] || areas[0] || temas[0] || 'Direito'}`
      case 'improve': {
        // Devolver o próprio texto da pessoa só quando ele não tem vedação: o
        // template não pode ser o caminho pelo qual um texto reprovado volta.
        const atual = dto.currentText?.trim()
        if (atual && !hasBlockingIssue(atual)) return atual
        return `Advogado(a) inscrito(a) na OAB${onde}. O trabalho é conduzido de forma técnica e informativa, orientando cada pessoa sobre seus direitos e os caminhos possíveis.`
      }
      case 'faq':
        // A pergunta chega em `areaLabel` (ver buildPrompt). Antes ela entrava como
        // sujeito: "De forma geral, Qual o prazo...? segue requisitos". Resposta de
        // reserva é genérica de propósito — é ponto de partida, não resposta.
        return TEMPLATE_NEUTRO.faq
      case 'bio':
      default: {
        const nome = this.itensSeguros([dto.name])[0]
        const who = nome ? `${nome} é advogado(a) inscrito(a) na OAB` : 'Advogado(a) inscrito(a) na OAB'
        return `${who}${onde}. O trabalho é conduzido de forma técnica e informativa, orientando cada pessoa sobre seus direitos e os caminhos possíveis, sempre observando a ética profissional.`
      }
    }
  }

  // O cliente é criado POR CHAMADA porque a chave pode mudar entre uma e outra:
  // com chaves de reserva, um cliente guardado no construtor congelaria a
  // primeira delas para sempre. Instanciar não custa nada — é só um invólucro.
  private async viaAnthropic(
    modelo: string,
    chave: string,
    prompt: string,
    maxTokens: number,
    limiteMs: number,
  ): Promise<string> {
    try {
      const res = await new Anthropic({ apiKey: chave, maxRetries: 0 }).messages.create(
        {
          model: modelo,
          max_tokens: maxTokens,
          system: OAB_SYSTEM,
          messages: [{ role: 'user', content: prompt }],
        },
        // `maxRetries: 0` acima: quem repete é o laço da cadeia, com o relógio
        // do pedido na mão — o SDK repetindo por conta própria estouraria o prazo.
        { timeout: limiteMs },
      )
      return res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim()
    } catch (err) {
      // O SDK traz erro tipado com status; sem ele a rotação de chave não
      // distingue "cota estourada" de "servidor fora do ar".
      const status = (err as { status?: number })?.status ?? 0
      throw new ErroDeProvedor('anthropic', status, (err as Error)?.message ?? 'falhou')
    }
  }

  // Google Gemini via REST (sem SDK). Chave gratuita em aistudio.google.com/app/apikey.
  private async viaGemini(
    modelo: string,
    chave: string,
    prompt: string,
    maxTokens: number,
    limiteMs: number,
  ): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${chave}`
    const data = (await this.postar(
      'gemini',
      url,
      { 'Content-Type': 'application/json' },
      {
        systemInstruction: { parts: [{ text: OAB_SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: maxTokens },
      },
      limiteMs,
    )) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }

    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .replace(/^["“']|["”']$/g, '')
      .trim()
    // Vazio (ex.: modelo gastou tudo "pensando") vira erro, para cair no elo seguinte.
    if (!text) throw new ErroDeProvedor('gemini', 0, 'resposta vazia')
    return text
  }

  /**
   * Groq, xAI (Grok) e OpenRouter numa função só.
   *
   * Os três falam a mesma língua — `POST /chat/completions` no formato da
   * OpenAI, com `Authorization: Bearer` —, então três implementações seriam três
   * lugares para o mesmo defeito aparecer. O que muda entre eles é o endereço
   * base e o nome do modelo, e os dois vêm do catálogo em provedores.ts.
   */
  private async viaOpenAiCompativel(
    provedor: Provider,
    base: string,
    modelo: string,
    chave: string,
    prompt: string,
    maxTokens: number,
    limiteMs: number,
  ): Promise<string> {
    const data = (await this.postarCom(
      limiteMs,
      provedor,
      `${base}/chat/completions`,
      {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${chave}`,
        // O OpenRouter pede identificação de quem chama; sem ela a requisição
        // passa, mas cai num balde de limite mais apertado.
        ...(provedor === 'openrouter'
          ? { 'HTTP-Referer': 'https://advoc.me', 'X-Title': 'advoc.me' }
          : {}),
      },
      {
        model: modelo,
        temperature: 0.7,
        max_tokens: maxTokens,
        ...PROVEDORES[provedor].corpoExtra?.(modelo),
        messages: [
          { role: 'system', content: OAB_SYSTEM },
          { role: 'user', content: prompt },
        ],
      },
    )) as { choices?: { message?: { content?: string } }[] }

    const text = (data.choices?.[0]?.message?.content ?? '')
      .replace(/^["“']|["”']$/g, '')
      .trim()
    if (!text) throw new ErroDeProvedor(provedor, 0, 'resposta vazia')
    return text
  }

  /**
   * POST com JSON, teto de tempo e erro que carrega o status.
   *
   * O status é o que separa "troque de chave" de "troque de provedor" (ver
   * chaveQueimada). E o teto de tempo é o que impede um provedor pendurado de
   * segurar a requisição do advogado até o navegador desistir: 20 s é folgado
   * para um texto de perfil e curto para uma espera.
   */
  private postarCom(
    limiteMs: number,
    provedor: Provider,
    url: string,
    headers: Record<string, string>,
    corpo: unknown,
  ): Promise<unknown> {
    return this.postar(provedor, url, headers, corpo, limiteMs)
  }

  private async postar(
    provedor: Provider,
    url: string,
    headers: Record<string, string>,
    corpo: unknown,
    // O teto desta chamada: nunca mais que TEMPO_POR_CHAMADA_MS, e menos quando
    // o pedido já gastou parte do orçamento (ver chamarProvedor).
    limiteMs: number = TEMPO_POR_CHAMADA_MS,
  ): Promise<unknown> {
    const abortar = new AbortController()
    const relogio = setTimeout(() => abortar.abort(), Math.max(1, limiteMs))
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(corpo),
        signal: abortar.signal,
      })
      if (!res.ok) {
        // O corpo do erro diz QUAL é o problema (modelo inexistente, cota,
        // formato) e é a única pista quando um provedor de reserva não sobe.
        const detalhe = (await res.text().catch(() => '')).slice(0, 300)
        throw new ErroDeProvedor(provedor, res.status, `respondeu ${res.status} ${detalhe}`)
      }
      return await res.json()
    } catch (err) {
      if (err instanceof ErroDeProvedor) throw err
      // Nomear o tempo esgotado é o que separa "repita" de "passe a vez" lá em
      // cima (ver valeRepetir/tempoEsgotou): 20 s já se foram, e um provedor
      // pendurado não merece mais 20.
      if ((err as Error)?.name === 'AbortError') {
        throw new ErroDeProvedor(provedor, 0, `tempo esgotado (${Math.round(limiteMs / 1000)} s)`)
      }
      throw new ErroDeProvedor(provedor, 0, (err as Error)?.message ?? 'falha de rede')
    } finally {
      clearTimeout(relogio)
    }
  }

  private async viaOllama(
    modelo: string,
    prompt: string,
    maxTokens: number,
    limiteMs: number,
  ): Promise<string> {
    const base = process.env.OLLAMA_URL ?? 'http://localhost:11434'
    const data = (await this.postarCom(
      limiteMs,
      'ollama',
      `${base}/api/chat`,
      { 'Content-Type': 'application/json' },
      {
        model: modelo,
        stream: false,
        options: { temperature: 0.7, num_predict: maxTokens },
        messages: [
          { role: 'system', content: OAB_SYSTEM },
          { role: 'user', content: prompt },
        ],
      },
    )) as { message?: { content?: string } }
    return (data.message?.content ?? '').replace(/^["“']|["”']$/g, '').trim()
  }
}
