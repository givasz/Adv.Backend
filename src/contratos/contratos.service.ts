// Registro e conferência de documentos (contratos, procurações).
//
// O que este serviço guarda é a IMPRESSÃO DIGITAL de um arquivo que nunca passa
// por aqui. O porquê está no comentário de `model RegistroDocumento`; três regras
// mandam no arquivo:
//
//   1. A DECLARAÇÃO É CONFERIDA NO SERVIDOR. "Revisei o documento" e "o conteúdo
//      é responsabilidade minha" valem só com `=== true` — a mesma régua do
//      aceite dos Termos. Um `"true"` em texto não é declaração de ninguém.
//
//   2. O PLANO VALE PARA O QUE É NOVO. Registrar uma minuta nova é do Max; ver o
//      próprio histórico, registrar a versão assinada de um documento que JÁ foi
//      registrado e conferir um arquivo não dependem de plano. Um registro que
//      deixa de ser consultável quando a assinatura vence não serve de prova.
//
//   3. A CONFERÊNCIA PÚBLICA DEVOLVE SÓ O QUE O PDF JÁ DIZ. Quem tem o arquivo
//      tem o código, o modelo e o nome do advogado impressos nele. Endereço de
//      IP, navegador e o id da conta não saem daqui por essa porta.

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { planoVigente } from '../assinatura'
import { canUseContratos } from '../plans'
import { clampText } from '../security/sanitize'
import {
  CODIGO_DE_REGISTRO,
  DECLARACAO_DE_REVISAO_VERSAO,
  ETAPAS_DE_REGISTRO,
  HASH_SHA256,
  MODELO_PROPRIO,
  MODELOS_DE_DOCUMENTO,
  MODELOS_LISTA,
  VERSAO_DE_MODELO_PROPRIO,
  TAMANHO_MAXIMO_BYTES,
  type EtapaDeRegistro,
  type ModeloDeDocumento,
} from './modelos'

/** Quantas versões assinadas um mesmo documento aceita (advogado, cliente, testemunhas…). */
const ASSINADAS_POR_DOCUMENTO = 20
/** Quantas impressões digitais uma conferência pode perguntar de uma vez. */
const HASHES_POR_CONFERENCIA = 12

interface Origem {
  ip: string
  userAgent: string
}

const CAMPOS_DO_DONO = {
  id: true,
  codigo: true,
  hash: true,
  tamanho: true,
  etapa: true,
  modelo: true,
  modeloVersao: true,
  origemId: true,
  declaracaoVersao: true,
  advogadoNome: true,
  advogadoOab: true,
  createdAt: true,
} as const

type LinhaDoDono = {
  id: string
  codigo: string
  hash: string
  tamanho: number
  etapa: string
  modelo: string
  modeloVersao: string
  origemId: string | null
  declaracaoVersao: string
  advogadoNome: string
  advogadoOab: string
  createdAt: Date
}

function paraODono(r: LinhaDoDono) {
  return {
    id: r.id,
    codigo: r.codigo,
    hash: r.hash,
    tamanho: r.tamanho,
    etapa: r.etapa as EtapaDeRegistro,
    modelo: r.modelo,
    modeloVersao: r.modeloVersao,
    origemId: r.origemId,
    declaracaoVersao: r.declaracaoVersao,
    advogado: { nome: r.advogadoNome, oab: r.advogadoOab },
    registradoEm: r.createdAt,
  }
}

@Injectable()
export class ContratosService {
  constructor(private readonly prisma: PrismaService) {}

  /** Os registros da própria conta, do mais recente para o mais antigo. */
  async listar(userId: string) {
    const linhas = await this.prisma.registroDocumento.findMany({
      where: { userId },
      select: CAMPOS_DO_DONO,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 500,
    })
    return { registros: linhas.map(paraODono) }
  }

  async registrar(userId: string, body: any, origem: Origem) {
    const etapa = ETAPAS_DE_REGISTRO.find((e) => e === body?.etapa)
    if (!etapa) throw new BadRequestException('Etapa de registro desconhecida.')

    const hash = typeof body?.hash === 'string' ? body.hash.toLowerCase() : ''
    if (!HASH_SHA256.test(hash)) {
      throw new BadRequestException('A impressão digital do arquivo chegou incompleta. Gere o PDF de novo.')
    }
    const tamanho = Number(body?.tamanho)
    if (!Number.isInteger(tamanho) || tamanho <= 0 || tamanho > TAMANHO_MAXIMO_BYTES) {
      throw new BadRequestException('O tamanho do arquivo chegou inválido. Gere o PDF de novo.')
    }

    return etapa === 'revisado'
      ? this.registrarRevisado(userId, body, hash, tamanho, origem)
      : this.registrarAssinado(userId, body, hash, tamanho, origem)
  }

  private async registrarRevisado(
    userId: string,
    body: any,
    hash: string,
    tamanho: number,
    origem: Origem,
  ) {
    // A declaração primeiro: sem ela não há o que registrar, e a mensagem é a
    // que o advogado precisa ler — antes de qualquer detalhe técnico.
    if (body?.declaracoes?.revisei !== true || body?.declaracoes?.responsabilidade !== true) {
      throw new BadRequestException(
        'Confirme que revisou o documento inteiro e que o conteúdo é de sua responsabilidade.',
      )
    }

    const proprio = body?.modelo === MODELO_PROPRIO
    const modelo = proprio
      ? MODELO_PROPRIO
      : (MODELOS_LISTA.find((m) => m === body?.modelo) as ModeloDeDocumento | undefined)
    if (!modelo) throw new BadRequestException('Modelo de documento desconhecido.')
    const modeloVersao: string = proprio
      ? typeof body?.modeloVersao === 'string' && VERSAO_DE_MODELO_PROPRIO.test(body.modeloVersao)
        ? body.modeloVersao
        : ''
      : MODELOS_DE_DOCUMENTO[modelo as ModeloDeDocumento]
    if (proprio && !modeloVersao) {
      throw new BadRequestException('A versão do seu modelo chegou inválida. Monte o documento de novo.')
    }
    if (!proprio && body?.modeloVersao !== modeloVersao) {
      throw new BadRequestException(
        'Este modelo foi atualizado desde que a página abriu. Recarregue a página e monte o documento de novo.',
      )
    }
    if (body?.declaracaoVersao !== DECLARACAO_DE_REVISAO_VERSAO) {
      throw new BadRequestException(
        'O texto da declaração mudou desde que a página abriu. Recarregue a página e confirme de novo.',
      )
    }

    const codigo = typeof body?.codigo === 'string' ? body.codigo : ''
    if (!CODIGO_DE_REGISTRO.test(codigo)) {
      throw new BadRequestException('O código do documento chegou inválido. Gere o PDF de novo.')
    }

    const perfil = await this.prisma.profile.findUnique({
      where: { userId },
      select: {
        name: true,
        oabNumber: true,
        plan: true,
        planStatus: true,
        currentPeriodEnd: true,
        graceUntil: true,
      },
    })
    // O PLANO É DO SERVIDOR: o que vale é o vigente, calculado da assinatura
    // gravada — nunca um `plan` que viesse no corpo.
    if (!perfil || !canUseContratos(planoVigente(perfil))) {
      throw new ForbiddenException('Registrar documentos faz parte do plano Max.')
    }
    if (!perfil.name.trim() || !perfil.oabNumber.trim()) {
      throw new BadRequestException(
        'Preencha seu nome e sua inscrição na OAB no perfil antes de registrar um documento.',
      )
    }

    // Mesmo arquivo registrado de novo (clique duplo, rede que caiu depois de
    // gravar): devolve o registro que já existe, sem criar outro.
    const jaExiste = await this.prisma.registroDocumento.findFirst({
      where: { userId, hash, etapa: 'revisado' },
      select: CAMPOS_DO_DONO,
    })
    if (jaExiste) return paraODono(jaExiste)

    const codigoEmUso = await this.prisma.registroDocumento.findFirst({
      where: { codigo, etapa: 'revisado' },
      select: { id: true },
    })
    // 409 com texto fixo: o aparelho sorteia outro código, refaz o PDF e tenta de
    // novo sozinho. O advogado nunca vê esta mensagem.
    if (codigoEmUso) throw new ConflictException('codigo-em-uso')

    const criado = await this.prisma.registroDocumento.create({
      data: {
        userId,
        codigo,
        hash,
        tamanho,
        etapa: 'revisado',
        modelo,
        modeloVersao,
        declaracaoVersao: DECLARACAO_DE_REVISAO_VERSAO,
        ip: origem.ip.slice(0, 60),
        userAgent: clampText(origem.userAgent, 300),
        advogadoNome: clampText(perfil.name, 120),
        advogadoOab: clampText(perfil.oabNumber, 40),
      },
      select: CAMPOS_DO_DONO,
    })
    return paraODono(criado)
  }

  private async registrarAssinado(
    userId: string,
    body: any,
    hash: string,
    tamanho: number,
    origem: Origem,
  ) {
    const codigo = typeof body?.origemCodigo === 'string' ? body.origemCodigo : ''
    if (!CODIGO_DE_REGISTRO.test(codigo)) {
      throw new BadRequestException('Indique de qual documento registrado esta versão assinada vem.')
    }
    // Só a partir de um documento DESTA conta: registrar a versão assinada do
    // contrato de outro advogado seria pendurar o nome dele num arquivo alheio.
    const doc = await this.prisma.registroDocumento.findFirst({
      where: { userId, codigo, etapa: 'revisado' },
      select: {
        id: true,
        hash: true,
        modelo: true,
        modeloVersao: true,
        advogadoNome: true,
        advogadoOab: true,
      },
    })
    if (!doc) throw new NotFoundException('Não encontramos esse documento entre os registros da sua conta.')
    if (doc.hash === hash) {
      throw new BadRequestException(
        'Este é o mesmo arquivo registrado na revisão — nenhuma assinatura foi acrescentada a ele.',
      )
    }

    const jaExiste = await this.prisma.registroDocumento.findFirst({
      where: { userId, hash, etapa: 'assinado' },
      select: CAMPOS_DO_DONO,
    })
    if (jaExiste) return paraODono(jaExiste)

    const quantas = await this.prisma.registroDocumento.count({
      where: { origemId: doc.id, etapa: 'assinado' },
    })
    if (quantas >= ASSINADAS_POR_DOCUMENTO) {
      throw new BadRequestException('Este documento já tem versões assinadas demais registradas.')
    }

    const criado = await this.prisma.registroDocumento.create({
      data: {
        userId,
        codigo,
        hash,
        tamanho,
        etapa: 'assinado',
        modelo: doc.modelo,
        modeloVersao: doc.modeloVersao,
        origemId: doc.id,
        ip: origem.ip.slice(0, 60),
        userAgent: clampText(origem.userAgent, 300),
        // A fotografia do documento de origem: é o mesmo documento, com
        // assinaturas. Um nome trocado no perfil entre uma coisa e outra não
        // pode fazer o contrato parecer de duas pessoas.
        advogadoNome: doc.advogadoNome,
        advogadoOab: doc.advogadoOab,
      },
      select: CAMPOS_DO_DONO,
    })
    return paraODono(criado)
  }

  /**
   * Conferência pública: estas impressões digitais estão registradas?
   *
   * Recebe mais de uma porque o aparelho de quem confere manda também o hash de
   * cada TRECHO INICIAL do arquivo que termina num fim de PDF (`%%EOF`). É assim
   * que uma versão assinada por um assinador que acrescenta ao fim — o do gov.br,
   * os de certificado ICP-Brasil — é reconhecida como contendo, intacto, o
   * documento registrado.
   */
  async conferir(entrada: unknown) {
    const lista = Array.isArray(entrada) ? entrada : []
    const hashes = [
      ...new Set(
        lista
          .filter((h): h is string => typeof h === 'string')
          .map((h) => h.trim().toLowerCase())
          .filter((h) => HASH_SHA256.test(h)),
      ),
    ].slice(0, HASHES_POR_CONFERENCIA)
    if (!hashes.length) {
      throw new BadRequestException('Envie a impressão digital (SHA-256) do arquivo a conferir.')
    }

    const linhas = await this.prisma.registroDocumento.findMany({
      where: { hash: { in: hashes } },
      // Nada de ip, userAgent, userId nem declaração: ver regra 3 no topo.
      select: {
        codigo: true,
        hash: true,
        tamanho: true,
        etapa: true,
        modelo: true,
        advogadoNome: true,
        advogadoOab: true,
        createdAt: true,
      },
      // O mais antigo primeiro: se dois registros têm o mesmo arquivo, quem o
      // registrou antes é a informação que importa.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 20,
    })

    return {
      registros: linhas.map((r) => ({
        codigo: r.codigo,
        hash: r.hash,
        tamanho: r.tamanho,
        etapa: r.etapa as EtapaDeRegistro,
        modelo: r.modelo,
        advogado: { nome: r.advogadoNome, oab: r.advogadoOab },
        registradoEm: r.createdAt,
      })),
    }
  }
}
