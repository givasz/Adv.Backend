import { Injectable } from '@nestjs/common'

/**
 * Consulta de CEP — a ponte entre o CEP que o advogado digita e a rua que ele
 * não deveria precisar digitar.
 *
 * ---------------------------------------------------------------------------
 * POR QUE PASSA PELO NOSSO SERVIDOR, E NÃO DIRETO DO NAVEGADOR
 *
 * O ViaCEP aceita chamada do navegador — dá para chamá-lo do editor em três
 * linhas. Três razões para não fazer isso:
 *
 * 1. O CEP do escritório é um dado do advogado. Mandá-lo do navegador dele para
 *    um servidor de terceiro conta a esse terceiro onde ele trabalha, junto com
 *    o IP e o cabeçalho de origem — e o advogado não escolheu esse terceiro.
 * 2. A plataforma inteira conversa com UMA origem só. É a mesma decisão do
 *    cookie de sessão (ver DEPLOY: endereço absoluto = cookie de terceiro =
 *    login quebrado no iPhone); abrir uma exceção aqui traz de volta a classe
 *    de problema que já custou caro uma vez.
 * 3. Um provedor fora do ar vira UM ponto de mudança nosso, não um bug de
 *    campo. Hoje são dois provedores em cascata; amanhã pode ser um arquivo
 *    nosso, sem tocar em nada do lado do navegador.
 *
 * NADA DISSO É GRAVADO. A consulta atravessa: o que fica no banco é só o que o
 * advogado salvar no perfil, pela porta normal do perfil.
 * ---------------------------------------------------------------------------
 */

/** O que devolvemos ao editor. Campos que o provedor não souber vêm vazios. */
export interface CepEncontrado {
  cep: string
  rua: string
  bairro: string
  cidade: string
  uf: string
}

// Um CEP não muda de rua. Guardar a resposta em memória evita repetir a mesma
// consulta a cada tecla apagada e redigitada — e segura o caso em que o
// provedor limita nosso IP num horário movimentado.
const CACHE_MAX = 2000
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const cache = new Map<string, { valor: CepEncontrado | null; ate: number }>()

// Teto curto de propósito: quem espera uma resposta é uma pessoa com o campo em
// branco na frente. Passou disso, é melhor ela digitar a rua do que olhar um
// carregando eterno — os campos continuam todos editáveis à mão.
const TIMEOUT_MS = 4000

@Injectable()
export class GeoService {
  /**
   * O endereço de um CEP, ou `null` quando ele não existe (ou quando nenhum
   * provedor respondeu — para quem digita, dá no mesmo: preencher à mão).
   */
  async cep(bruto: string): Promise<CepEncontrado | null> {
    const digitos = (bruto ?? '').replace(/\D/g, '')
    if (digitos.length !== 8) return null

    const guardado = cache.get(digitos)
    if (guardado && guardado.ate > Date.now()) return guardado.valor

    // Dois provedores em cascata, ambos públicos e sem chave. O segundo existe
    // porque o primeiro sozinho transformava "o ViaCEP está fora" em "o campo
    // de CEP do advoc.me está quebrado".
    const achado = (await this.viaCep(digitos)) ?? (await this.brasilApi(digitos))

    // O negativo também é guardado: um CEP inexistente digitado por engano seria
    // reconsultado a cada tecla enquanto a pessoa corrige o número.
    this.guardar(digitos, achado)
    return achado
  }

  private guardar(chave: string, valor: CepEncontrado | null) {
    // Cache de tamanho fixo: sem teto, uma varredura de CEPs encheria a memória
    // do processo. A entrada mais antiga sai primeiro (Map preserva a ordem de
    // inserção), que é o suficiente para o volume disto.
    if (cache.size >= CACHE_MAX) {
      const maisAntiga = cache.keys().next().value
      if (maisAntiga !== undefined) cache.delete(maisAntiga)
    }
    cache.set(chave, { valor, ate: Date.now() + CACHE_TTL_MS })
  }

  /** GET com teto de tempo. Erro de rede e resposta ruim viram `null`, não exceção. */
  private async buscarJson(url: string): Promise<any | null> {
    const abortar = new AbortController()
    const relogio = setTimeout(() => abortar.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        signal: abortar.signal,
        headers: { accept: 'application/json' },
      })
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null
    } finally {
      clearTimeout(relogio)
    }
  }

  private async viaCep(digitos: string): Promise<CepEncontrado | null> {
    const j = await this.buscarJson(`https://viacep.com.br/ws/${digitos}/json/`)
    // O ViaCEP responde 200 com `{ "erro": true }` para CEP inexistente — o
    // status HTTP sozinho não distingue "não existe" de "existe".
    if (!j || j.erro || typeof j.logradouro !== 'string') return null
    return {
      cep: digitos,
      rua: String(j.logradouro ?? ''),
      bairro: String(j.bairro ?? ''),
      cidade: String(j.localidade ?? ''),
      uf: String(j.uf ?? '').toUpperCase(),
    }
  }

  private async brasilApi(digitos: string): Promise<CepEncontrado | null> {
    const j = await this.buscarJson(`https://brasilapi.com.br/api/cep/v1/${digitos}`)
    if (!j || typeof j.state !== 'string') return null
    return {
      cep: digitos,
      rua: String(j.street ?? ''),
      bairro: String(j.neighborhood ?? ''),
      cidade: String(j.city ?? ''),
      uf: String(j.state ?? '').toUpperCase(),
    }
  }
}
