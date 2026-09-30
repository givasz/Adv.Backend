// A SAÍDA para o Asaas — o que NÓS pedimos a ele. A entrada (o que ele nos conta)
// mora em asaas.ts, em funções puras. Aqui é rede, e por isso é pequeno: cada
// método é uma chamada, sem regra de negócio. A regra está em checkout.service.ts.
//
// ---------------------------------------------------------------------------
// O QUE NUNCA ACONTECE NESTE ARQUIVO
//
// Nenhum corpo de requisição vai para log. Nem de resposta. Por aqui passam
// número de cartão, validade, código de segurança e CPF — e log é o lugar por onde
// cartão costuma vazar sem ninguém perceber: um `console.log(body)` de depuração
// esquecido, um erro que carrega o pedido inteiro na mensagem. O que se registra
// é método, caminho, status e o CÓDIGO de erro do Asaas. Nada que a pessoa digitou.
// ---------------------------------------------------------------------------
//
// AMBIENTE
//
// `ASAAS_AMBIENTE` precisa dizer `sandbox` ou `producao`, com todas as letras. Não
// há padrão: um padrão "produção" faria a primeira máquina de teste cobrar cartão
// de verdade, e um padrão "sandbox" faria a produção fingir que cobrou. Sem a
// variável — ou sem a chave — o checkout responde que o pagamento on-line não está
// disponível, e nada sai daqui.

import { Injectable, Logger } from '@nestjs/common'

export type MeioDePagamento = 'CREDIT_CARD' | 'PIX' | 'BOLETO'

const BASE: Record<string, string> = {
  sandbox: 'https://api-sandbox.asaas.com/v3',
  producao: 'https://api.asaas.com/v3',
}

/**
 * Teto por chamada. O checkout passa pelo proxy do Netlify, que corta em 26 s, e
 * um checkout faz até quatro chamadas em sequência (cliente, assinatura,
 * cobranças, QR Code). Doze segundos por chamada é folga para a autorização do
 * cartão e ainda deixa o erro chegar ao advogado como mensagem nossa, e não como
 * uma página de erro do proxy.
 */
const TETO_MS = 12_000

/** Erro vindo do Asaas (ou da rede até ele). A mensagem nunca contém o que foi enviado. */
export class AsaasErro extends Error {
  constructor(
    readonly status: number,
    readonly codigo: string,
    /** a descrição que o ASAAS devolveu — é o que pode ser mostrado ao advogado */
    readonly descricao: string,
  ) {
    super(`Asaas ${status} ${codigo}`)
  }
}

export interface Cartao {
  nomeImpresso: string
  numero: string
  mes: string
  ano: string
  cvv: string
}

export interface Titular {
  nome: string
  email: string
  cpfCnpj: string
  cep: string
  numeroEndereco: string
  telefone: string
}

export interface AssinaturaAsaas {
  id: string
  billingType: MeioDePagamento
  status: string
  nextDueDate: string
  externalReference?: string
  creditCard?: { creditCardNumber?: string; creditCardBrand?: string }
}

export interface CobrancaAsaas {
  id: string
  billingType: string
  status: string
  dueDate: string
  value: number
  invoiceUrl?: string
  bankSlipUrl?: string | null
}

export interface PixAsaas {
  /** PNG em base64, sem o prefixo `data:` */
  encodedImage: string
  /** o "copia e cola" */
  payload: string
  expirationDate?: string
}

@Injectable()
export class AsaasApi {
  private readonly log = new Logger('Asaas')

  private get chave(): string {
    return (process.env.ASAAS_API_KEY ?? '').trim()
  }

  private get base(): string {
    return BASE[(process.env.ASAAS_AMBIENTE ?? '').trim()] ?? ''
  }

  /** Há chave e ambiente declarados? Sem os dois, nada sai daqui. */
  get configurado(): boolean {
    return !!this.chave && !!this.base
  }

  get ambiente(): string {
    return (process.env.ASAAS_AMBIENTE ?? '').trim()
  }

  private async chamar<T>(metodo: string, caminho: string, corpo?: unknown): Promise<T> {
    if (!this.configurado) throw new AsaasErro(0, 'nao_configurado', 'Pagamento on-line indisponível.')
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TETO_MS)
    let resposta: Response
    try {
      resposta = await fetch(this.base + caminho, {
        method: metodo,
        headers: {
          access_token: this.chave,
          'content-type': 'application/json',
          'User-Agent': 'advoc.me',
        },
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
        signal: ctrl.signal,
      })
    } catch (e) {
      const tempo = (e as Error)?.name === 'AbortError'
      this.log.warn(`${metodo} ${caminho} → ${tempo ? 'tempo esgotado' : 'falha de rede'}`)
      throw new AsaasErro(0, tempo ? 'tempo_esgotado' : 'rede', 'O provedor de pagamento não respondeu.')
    } finally {
      clearTimeout(timer)
    }

    const json = (await resposta.json().catch(() => ({}))) as any
    if (!resposta.ok) {
      const erro = Array.isArray(json?.errors) ? json.errors[0] : undefined
      const codigo = typeof erro?.code === 'string' ? erro.code.slice(0, 60) : 'erro'
      const descricao = typeof erro?.description === 'string' ? erro.description.slice(0, 300) : ''
      // Status e código, e só. A descrição do Asaas pode citar o que foi enviado
      // (um CPF recusado, por exemplo), então não vai para o log.
      this.log.warn(`${metodo} ${caminho} → ${resposta.status} ${codigo}`)
      throw new AsaasErro(resposta.status, codigo, descricao)
    }
    return json as T
  }

  criarCliente(dados: { nome: string; cpfCnpj: string; email: string; externalReference: string }) {
    return this.chamar<{ id: string }>('POST', '/customers', {
      name: dados.nome,
      cpfCnpj: dados.cpfCnpj,
      email: dados.email,
      externalReference: dados.externalReference,
    })
  }

  /** O cliente já existe (tentativa anterior): nome e documento podem ter mudado. */
  atualizarCliente(id: string, dados: { nome: string; cpfCnpj: string; email: string }) {
    return this.chamar<{ id: string }>('PUT', `/customers/${encodeURIComponent(id)}`, {
      name: dados.nome,
      cpfCnpj: dados.cpfCnpj,
      email: dados.email,
    })
  }

  criarAssinatura(p: {
    customer: string
    meio: MeioDePagamento
    valor: number
    vencimento: string
    descricao: string
    externalReference: string
    cartao?: Cartao
    titular?: Titular
    remoteIp?: string
  }) {
    return this.chamar<AssinaturaAsaas>('POST', '/subscriptions', {
      customer: p.customer,
      billingType: p.meio,
      value: p.valor,
      nextDueDate: p.vencimento,
      cycle: 'MONTHLY',
      description: p.descricao,
      externalReference: p.externalReference,
      ...(p.meio === 'CREDIT_CARD' && p.cartao && p.titular
        ? {
            creditCard: {
              holderName: p.cartao.nomeImpresso,
              number: p.cartao.numero,
              expiryMonth: p.cartao.mes,
              expiryYear: p.cartao.ano,
              ccv: p.cartao.cvv,
            },
            creditCardHolderInfo: {
              name: p.titular.nome,
              email: p.titular.email,
              cpfCnpj: p.titular.cpfCnpj,
              postalCode: p.titular.cep,
              addressNumber: p.titular.numeroEndereco,
              phone: p.titular.telefone,
            },
            remoteIp: p.remoteIp,
          }
        : {}),
    })
  }

  /**
   * As assinaturas vivas de um cliente.
   *
   * Existe por causa do tempo esgotado: se a criação da assinatura passa dos 12 s,
   * nós desistimos de esperar — mas o Asaas pode ter criado a assinatura e cobrado
   * o cartão do lado dele. Sem esta consulta, a segunda tentativa do advogado
   * criaria outra, e cobraria de novo. Ver `CheckoutService.assinar`.
   */
  async assinaturasDoCliente(customer: string): Promise<(AssinaturaAsaas & { deleted?: boolean })[]> {
    const r = await this.chamar<{ data?: (AssinaturaAsaas & { deleted?: boolean })[] }>(
      'GET',
      `/subscriptions?customer=${encodeURIComponent(customer)}&limit=100`,
    )
    return (r.data ?? []).filter((s) => !s.deleted)
  }

  async cobrancasDaAssinatura(id: string): Promise<CobrancaAsaas[]> {
    const r = await this.chamar<{ data?: CobrancaAsaas[] }>(
      'GET',
      `/subscriptions/${encodeURIComponent(id)}/payments`,
    )
    // A mais antiga primeiro: é a do ciclo que está sendo pago agora.
    return [...(r.data ?? [])].sort((a, b) => a.dueDate.localeCompare(b.dueDate))
  }

  pixQrCode(cobrancaId: string) {
    return this.chamar<PixAsaas>('GET', `/payments/${encodeURIComponent(cobrancaId)}/pixQrCode`)
  }

  /**
   * Apaga a assinatura no Asaas — e com ela as cobranças ainda não pagas.
   *
   * "Não existe" conta como sucesso: o que se quer é que ela não exista, e uma
   * segunda tentativa (clique duplo, repetição depois de erro de rede) não pode
   * virar erro para o advogado.
   */
  async cancelarAssinatura(id: string): Promise<void> {
    try {
      await this.chamar('DELETE', `/subscriptions/${encodeURIComponent(id)}`)
    } catch (e) {
      if (e instanceof AsaasErro && e.status === 404) return
      throw e
    }
  }
}
