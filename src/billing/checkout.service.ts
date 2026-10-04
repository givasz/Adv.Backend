// O CHECKOUT — o advogado escolhe o plano e a forma de pagamento, e a assinatura
// nasce no Asaas.
//
// ---------------------------------------------------------------------------
// QUEM ATIVA O PLANO
//
// Não é este arquivo, com uma exceção. O plano é ativado pelo PAGAMENTO
// CONFIRMADO, que chega pelo webhook (asaas.ts → BillingService). Pix e boleto
// terminam aqui em "aguardando": devolvemos o QR Code ou o boleto, e o plano abre
// quando o Asaas avisar que o dinheiro entrou.
//
// A exceção é o cartão aprovado na hora. O Asaas já devolve a cobrança como
// CONFIRMADA na resposta da criação, e fazer o advogado esperar o webhook para ver
// o plano aberto seria esperar por uma notícia que já temos. Então ativamos aqui,
// pela MESMA porta (aplicarAssinaturaPorPerfil) e com a MESMA data
// (fimDoPeriodoPorVencimento) que o webhook usaria. Quando ele chegar, segundos
// depois, regrava o mesmo estado — e nada muda.
//
// ---------------------------------------------------------------------------
// O QUE NUNCA É GRAVADO
//
// Número do cartão, validade, código de segurança, CPF/CNPJ, CEP e telefone de
// quem paga. Tudo isso passa por aqui a caminho do Asaas e para aí. Do nosso lado
// ficam só os identificadores (cliente e assinatura no Asaas). Os testes conferem
// que nenhuma escrita no banco carrega esses dados.
//
// ---------------------------------------------------------------------------
// O PREÇO É DO SERVIDOR
//
// O valor cobrado sai de PLAN_PRICE (plans.ts), e o que o navegador mandar no
// corpo é ignorado. Senão "assinar o Max por R$ 1" seria um campo editável.

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { ProfilesService } from '../profiles/profiles.service'
import { CorreioService } from '../mail/correio.service'
import { PLAN_NAME, PLAN_PRICE } from '../plans'
import { aoConfirmarPagamento, planoVigente } from '../assinatura'
import { AsaasApi, AsaasErro, type Cartao, type MeioDePagamento, type Titular } from './asaas.api'
import { fimDoPeriodoPorVencimento, marcaExterna } from './asaas'
import { digitos, documentoValido } from './documento'

type PlanoPago = 'pro' | 'premium'

const MEIOS: MeioDePagamento[] = ['CREDIT_CARD', 'PIX', 'BOLETO']
const ROTULO_DO_MEIO: Record<MeioDePagamento, string> = {
  CREDIT_CARD: 'cartão',
  PIX: 'Pix',
  BOLETO: 'boleto',
}

export type ResultadoDoCheckout =
  | {
      meio: 'CREDIT_CARD'
      /** ativo = aprovado agora; agendado = primeira cobrança numa data futura; em_analise = o Asaas ainda decide */
      situacao: 'ativo' | 'agendado' | 'em_analise'
      plano: PlanoPago
      valor: number
      vencimento?: string
      cartao: { final?: string; bandeira?: string }
    }
  | {
      meio: 'PIX'
      situacao: 'aguardando' | 'agendado'
      plano: PlanoPago
      valor: number
      vencimento?: string
      pix?: { imagem: string; copiaECola: string; expiraEm?: string }
      /** a página de pagamento do Asaas — alternativa se o QR Code não vier */
      fatura?: string
    }
  | {
      meio: 'BOLETO'
      situacao: 'aguardando' | 'agendado'
      plano: PlanoPago
      valor: number
      vencimento?: string
      boleto?: string
      fatura?: string
    }

/** Hoje em Brasília (sem horário de verão desde 2019: UTC−3 fixo), como o Asaas espera. */
function hojeEmBrasilia(agora = new Date()): string {
  return new Date(agora.getTime() - 3 * 3600_000).toISOString().slice(0, 10)
}

function texto(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

/** Luhn: o dígito final confere a soma. Pega erro de digitação antes de gastar uma tentativa. */
function luhn(numero: string): boolean {
  let soma = 0
  for (let i = 0; i < numero.length; i++) {
    let d = Number(numero[numero.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    soma += d
  }
  return soma % 10 === 0
}

interface PedidoLimpo {
  plano: PlanoPago
  meio: MeioDePagamento
  cpfCnpj: string
  cartao?: Cartao
  titular?: Omit<Titular, 'nome' | 'email' | 'cpfCnpj'>
}

/**
 * O corpo vem do navegador: tudo é conferido campo a campo, e a mensagem de erro
 * diz qual campo corrigir. Nenhuma mensagem ecoa o que foi digitado.
 *
 * `exigirLuhn`: todo cartão REAL passa no dígito verificador, então em produção a
 * conferência pega erro de digitação antes de gastar uma tentativa. Mas o cartão
 * de teste do sandbox do Asaas (4444 4444 4444 4444) NÃO passa — conferido em
 * 29/09/2026 —, e exigir Luhn no sandbox recusaria justamente o cartão de teste.
 */
export function limparPedido(
  bruto: unknown,
  { agora = new Date(), exigirLuhn = true }: { agora?: Date; exigirLuhn?: boolean } = {},
): PedidoLimpo {
  const b = (bruto && typeof bruto === 'object' ? bruto : {}) as Record<string, any>
  const plano = b.plano === 'pro' || b.plano === 'premium' ? (b.plano as PlanoPago) : null
  if (!plano) throw new BadRequestException('Plano inválido.')
  const meio = MEIOS.includes(b.meio) ? (b.meio as MeioDePagamento) : null
  if (!meio) throw new BadRequestException('Escolha a forma de pagamento.')
  if (meio !== 'CREDIT_CARD') {
    const cpfCnpj = documentoValido(b.cpfCnpj)
    if (!cpfCnpj) throw new BadRequestException('Confira o CPF ou CNPJ: o número não é válido.')
    return { plano, meio, cpfCnpj }
  }
  return { plano, meio, ...limparCartao(b, { agora, exigirLuhn }) }
}

/**
 * Documento, cartão e endereço da fatura — a parte do pedido que também serve à
 * troca de cartão e à troca de plano no cartão (ver minha-assinatura.service.ts).
 * Mesmas regras, mesmas mensagens, em um lugar só.
 */
export function limparCartao(
  bruto: unknown,
  { agora = new Date(), exigirLuhn = true }: { agora?: Date; exigirLuhn?: boolean } = {},
): Required<Pick<PedidoLimpo, 'cpfCnpj' | 'cartao' | 'titular'>> {
  const b = (bruto && typeof bruto === 'object' ? bruto : {}) as Record<string, any>
  const cpfCnpj = documentoValido(b.cpfCnpj)
  if (!cpfCnpj) throw new BadRequestException('Confira o CPF ou CNPJ: o número não é válido.')

  const c = (b.cartao && typeof b.cartao === 'object' ? b.cartao : {}) as Record<string, unknown>
  const numero = digitos(c.numero)
  if (numero.length < 13 || numero.length > 19 || (exigirLuhn && !luhn(numero))) {
    throw new BadRequestException('Confira o número do cartão.')
  }
  const nomeImpresso = texto(c.nomeImpresso, 60)
  if (nomeImpresso.length < 2) throw new BadRequestException('Informe o nome como está impresso no cartão.')
  const mes = Number(digitos(c.mes))
  let ano = Number(digitos(c.ano))
  if (ano >= 0 && ano < 100) ano += 2000
  const hoje = new Date(hojeEmBrasilia(agora))
  const vencido =
    ano < hoje.getUTCFullYear() || (ano === hoje.getUTCFullYear() && mes < hoje.getUTCMonth() + 1)
  if (!(mes >= 1 && mes <= 12) || vencido || ano > hoje.getUTCFullYear() + 25) {
    throw new BadRequestException('Confira a validade do cartão.')
  }
  const cvv = digitos(c.cvv)
  if (cvv.length < 3 || cvv.length > 4) throw new BadRequestException('Confira o código de segurança do cartão.')

  const t = (b.titular && typeof b.titular === 'object' ? b.titular : {}) as Record<string, unknown>
  const cep = digitos(t.cep)
  if (cep.length !== 8) throw new BadRequestException('Confira o CEP do endereço da fatura do cartão.')
  const numeroEndereco = texto(t.numeroEndereco, 10)
  if (!numeroEndereco) throw new BadRequestException('Informe o número do endereço da fatura do cartão.')
  const telefone = digitos(t.telefone)
  if (telefone.length < 10 || telefone.length > 11) throw new BadRequestException('Confira o telefone, com DDD.')

  return {
    cpfCnpj,
    cartao: { nomeImpresso, numero, mes: String(mes).padStart(2, '0'), ano: String(ano), cvv },
    titular: { cep, numeroEndereco, telefone },
  }
}

@Injectable()
export class CheckoutService {
  private readonly log = new Logger('Checkout')

  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: ProfilesService,
    private readonly asaas: AsaasApi,
    // Opcional só para os testes. No app vem do CorreioModule — ver o e-mail
    // confirmado em `assinar`, mesma regra de ProfilesService.setPlan.
    private readonly correio?: CorreioService,
  ) {}

  private indisponivel(): never {
    throw new ServiceUnavailableException(
      'O pagamento on-line não está disponível agora. Tente de novo em instantes.',
    )
  }

  async assinar(userId: string, bruto: unknown, remoteIp: string): Promise<ResultadoDoCheckout> {
    if (!this.asaas.configurado) this.indisponivel()
    const pedido = limparPedido(bruto, { exigirLuhn: this.asaas.ambiente !== 'sandbox' })

    const perfil = await this.prisma.profile.findUnique({
      where: { userId },
      select: {
        id: true,
        name: true,
        plan: true,
        planStatus: true,
        currentPeriodEnd: true,
        graceUntil: true,
        planScheduled: true,
        billingCustomerId: true,
        billingSubscriptionId: true,
        user: { select: { email: true, emailVerifiedAt: true } },
      },
    })
    if (!perfil) throw new NotFoundException('Perfil não encontrado')

    // Mesma regra de setPlan: assinatura presa a um e-mail digitado errado é a
    // pessoa descobrindo que o plano caiu quando o perfil já mudou. Só com o
    // correio ligado — exigir um link que não sai trancaria a compra de todos.
    if (this.correio?.ativo && !perfil.user?.emailVerifiedAt) {
      throw new ForbiddenException(
        'Confirme seu e-mail antes de assinar: é por ele que chegam a cobrança e os avisos do plano. ' +
          'Abra o link que mandamos, ou peça outro nesta página.',
      )
    }

    const agora = new Date()
    const vigente = planoVigente(perfil as any, agora)
    // Assinatura em dia (ou em carência): trocar de plano ou de forma de pagamento
    // ainda não passa por aqui. Criar uma segunda seria cobrar duas vezes.
    if (perfil.billingSubscriptionId && vigente !== 'free' && perfil.planStatus !== 'canceled') {
      throw new ConflictException(
        'Você já tem uma assinatura ativa. Para mudar de plano, trocar o cartão ou cancelar, ' +
          'use Minha assinatura.',
      )
    }

    // Quem cancelou e ainda tem dias pagos começa a pagar a nova quando os dias
    // pagos acabarem — não hoje. Cobrar hoje seria cobrar duas vezes o mesmo mês.
    const fimPago = perfil.currentPeriodEnd ? new Date(perfil.currentPeriodEnd) : null
    const vencimento =
      perfil.planStatus === 'canceled' && vigente !== 'free' && fimPago && fimPago > agora
        ? hojeEmBrasilia(fimPago)
        : hojeEmBrasilia(agora)
    const hoje = hojeEmBrasilia(agora)

    const email = perfil.user?.email ?? ''
    const nome = perfil.name?.trim() || email
    const marca = marcaExterna(perfil.id, pedido.plano)

    try {
      // ---- 1. Cliente -------------------------------------------------------
      let customer = perfil.billingCustomerId
      if (customer) {
        try {
          await this.asaas.atualizarCliente(customer, { nome, cpfCnpj: pedido.cpfCnpj, email })
        } catch (e) {
          if (!(e instanceof AsaasErro && e.status === 404)) throw e
          customer = null // apagado no Asaas: cria outro
        }
      }
      if (!customer) {
        customer = (
          await this.asaas.criarCliente({
            nome,
            cpfCnpj: pedido.cpfCnpj,
            email,
            externalReference: `advocme:${perfil.id}`,
          })
        ).id
        await this.prisma.profile.update({ where: { id: perfil.id }, data: { billingCustomerId: customer } })
        // Só e-mail: é por ele que o Pix e o boleto de cada mês chegam. SMS,
        // WhatsApp e ligação têm tarifa e não combinam com a plataforma. Falhar
        // aqui não pode derrubar a assinatura — fica o padrão do Asaas, e o log.
        await this.asaas.notificacoesSoPorEmail(customer).catch((e) => {
          this.log.warn(`notificações do cliente não ajustadas: ${e instanceof AsaasErro ? e.codigo : 'erro'}`)
        })
      }

      // ---- 2. O que ficou de tentativas anteriores ---------------------------
      //
      // A assinatura que o perfil aponta, se o plano nunca chegou a ser pago (Pix
      // abandonado, boleto não pago) ou se já foi cancelada, sai do caminho.
      //
      // E as assinaturas do cliente no Asaas são conferidas uma a uma, por causa do
      // tempo esgotado: se a tentativa anterior estourou os 65 s, o Asaas pode ter
      // criado a assinatura — e cobrado o cartão — sem que soubéssemos. Uma igual à
      // pedida (mesmo plano, mesmo meio) é ADOTADA, não duplicada. Qualquer outra
      // nossa sai.
      if (perfil.billingSubscriptionId) {
        await this.asaas.cancelarAssinatura(perfil.billingSubscriptionId)
        await this.prisma.profile.update({ where: { id: perfil.id }, data: { billingSubscriptionId: null } })
      }
      const existentes = (await this.asaas.assinaturasDoCliente(customer)).filter((s) =>
        (s.externalReference ?? '').startsWith(`advocme:${perfil.id}:`),
      )
      let assinatura = existentes.find((s) => s.externalReference === marca && s.billingType === pedido.meio)
      for (const s of existentes) {
        if (s !== assinatura) await this.asaas.cancelarAssinatura(s.id)
      }

      // ---- 3. A assinatura ----------------------------------------------------
      if (!assinatura) {
        assinatura = await this.asaas.criarAssinatura({
          customer,
          meio: pedido.meio,
          valor: PLAN_PRICE[pedido.plano],
          vencimento,
          descricao: `advoc.me ${PLAN_NAME[pedido.plano]} (mensal)`,
          externalReference: marca,
          cartao: pedido.cartao,
          titular: pedido.titular && {
            ...pedido.titular,
            nome: pedido.cartao?.nomeImpresso ?? nome,
            email,
            cpfCnpj: pedido.cpfCnpj,
          },
          remoteIp,
        })
      }

      // O Asaas troca Pix por boleto EM SILÊNCIO quando a conta não tem chave Pix
      // (visto no sandbox em 29/09/2026). Quem escolheu Pix não pode receber um
      // boleto sem saber: desfaz e diz o que houve.
      if (assinatura.billingType !== pedido.meio) {
        this.log.error(
          `pedido ${pedido.meio}, Asaas devolveu ${assinatura.billingType} — confira a configuração da conta (chave Pix?)`,
        )
        await this.asaas.cancelarAssinatura(assinatura.id).catch(() => {})
        throw new ServiceUnavailableException(
          `Não foi possível gerar a cobrança por ${ROTULO_DO_MEIO[pedido.meio]} agora. Escolha outra forma de pagamento.`,
        )
      }

      await this.prisma.profile.update({
        where: { id: perfil.id },
        data: { billingSubscriptionId: assinatura.id },
      })

      // ---- 4. A primeira cobrança -------------------------------------------
      const [primeira] = await this.asaas.cobrancasDaAssinatura(assinatura.id)
      const base = {
        plano: pedido.plano,
        valor: PLAN_PRICE[pedido.plano],
        vencimento: primeira?.dueDate ?? assinatura.nextDueDate,
      }
      const futura = !!base.vencimento && base.vencimento > hoje

      if (pedido.meio === 'CREDIT_CARD') {
        const cartao = {
          final: assinatura.creditCard?.creditCardNumber,
          bandeira: assinatura.creditCard?.creditCardBrand,
        }
        if (primeira && (primeira.status === 'CONFIRMED' || primeira.status === 'RECEIVED')) {
          const fim = fimDoPeriodoPorVencimento(primeira.dueDate)
          await this.profiles.aplicarAssinaturaPorPerfil(
            perfil.id,
            { ...aoConfirmarPagamento(pedido.plano, fim ? new Date(fim) : null), planScheduled: null },
            'checkout: cartão confirmado no Asaas',
          )
          return { meio: 'CREDIT_CARD', situacao: 'ativo', ...base, cartao }
        }
        return { meio: 'CREDIT_CARD', situacao: futura ? 'agendado' : 'em_analise', ...base, cartao }
      }

      if (pedido.meio === 'PIX') {
        if (futura || !primeira) return { meio: 'PIX', situacao: 'agendado', ...base }
        const pix = await this.asaas.pixQrCode(primeira.id).catch(() => null)
        return {
          meio: 'PIX',
          situacao: 'aguardando',
          ...base,
          pix: pix
            ? { imagem: pix.encodedImage, copiaECola: pix.payload, expiraEm: pix.expirationDate }
            : undefined,
          fatura: primeira.invoiceUrl,
        }
      }

      if (futura || !primeira) return { meio: 'BOLETO', situacao: 'agendado', ...base }
      return {
        meio: 'BOLETO',
        situacao: 'aguardando',
        ...base,
        boleto: primeira.bankSlipUrl ?? undefined,
        fatura: primeira.invoiceUrl,
      }
    } catch (e) {
      if (!(e instanceof AsaasErro)) throw e
      if (e.codigo === 'nao_configurado') this.indisponivel()
      // Recusa do cartão, dado recusado pelo Asaas: a descrição DELE diz o que
      // corrigir ("Transação não autorizada. Verifique os dados do cartão…").
      if (e.status === 400 && e.descricao) throw new BadRequestException(e.descricao)
      if (e.codigo === 'tempo_esgotado') {
        // Não dá para afirmar que nada foi cobrado: o Asaas pode ter concluído do
        // lado dele. A próxima tentativa ADOTA a assinatura criada, se houver.
        throw new ServiceUnavailableException(
          'O provedor de pagamento demorou para responder. Tente de novo: se o pagamento já tiver ' +
            'sido feito, ele é reconhecido e não é cobrado duas vezes.',
        )
      }
      throw new ServiceUnavailableException(
        'Não foi possível falar com o provedor de pagamento agora. Tente de novo em instantes.',
      )
    }
  }
}
