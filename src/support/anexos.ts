import { BadRequestException } from '@nestjs/common'

// Imagens anexadas a um chamado de suporte.
//
// Um print vale mais que três parágrafos de "não funciona" — mas imagem é o
// arquivo mais fácil de usar para outra coisa. As regras abaixo são o que separa
// uma coisa da outra.
//
// O QUE ENTRA
//
//   • Só PNG, JPEG e WebP, decididos pelos BYTES (a assinatura do formato), e não
//     pelo rótulo do data URI. Um "image/png" que é HTML, SVG ou executável não
//     entra. SVG fica de fora de propósito: é documento com script, não imagem.
//   • O rótulo tem de bater com os bytes. O navegador que re-codificou a imagem
//     (frontend/src/lib/anexoImagem.ts) sempre acerta; divergência é montagem à mão.
//   • Tamanho acima do teto é RECUSADO, nunca cortado: imagem cortada é imagem
//     corrompida, e o advogado acharia que mandou.
//
// POR QUE O TETO É ESTE
//
// O corpo da requisição é limitado a 1 MB (main.ts), e o chamado inteiro viaja
// num pedido só. Três imagens de 300 mil caracteres cabem com folga ao lado do
// texto. O navegador comprime cada imagem para ficar abaixo disso antes de enviar.
//
// COMO SAI
//
// Só por rota autenticada, uma imagem por pedido, para o autor do chamado ou
// para o painel (`suporte:ler`). Com `nosniff` e o tipo que os bytes decidiram —
// e com o CSP `default-src 'none'` que toda resposta da API já leva.

export const ANEXOS_MAX = 3

/** Caracteres do data URI de UMA imagem. Espelha ANEXO_DATA_URL_MAX do front. */
export const ANEXO_DATA_URI_MAX = 300_000

/** Imagens por conta em 24 horas. Segura quem usa o suporte como depósito de arquivo. */
export const ANEXOS_POR_DIA = 15

export const TIPOS_DE_ANEXO = ['image/png', 'image/jpeg', 'image/webp'] as const
export type TipoDeAnexo = (typeof TIPOS_DE_ANEXO)[number]

export interface AnexoLido {
  contentType: TipoDeAnexo
  bytes: Buffer
}

/** O formato pela assinatura dos primeiros bytes — ou null, se não for um dos três. */
export function tipoPelosBytes(b: Uint8Array): TipoDeAnexo | null {
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (
    b.length >= 16 &&
    ascii(b, 0, 4) === 'RIFF' &&
    ascii(b, 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

function ascii(b: Uint8Array, de: number, ate: number): string {
  return Array.from(b.subarray(de, ate), (c) => String.fromCharCode(c)).join('')
}

const DATA_URI = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/

/**
 * Lê o campo `anexos` do corpo do chamado. Ausente é lista vazia; qualquer coisa
 * fora da regra é recusada com uma frase que o advogado entende.
 */
export function lerAnexos(valor: unknown): AnexoLido[] {
  if (valor === undefined || valor === null) return []
  if (!Array.isArray(valor)) throw new BadRequestException('Não foi possível ler as imagens anexadas.')
  if (valor.length > ANEXOS_MAX) {
    throw new BadRequestException(`Envie até ${ANEXOS_MAX} imagens por chamado.`)
  }
  return valor.map((v) => {
    if (typeof v !== 'string') throw new BadRequestException('Não foi possível ler as imagens anexadas.')
    if (v.length > ANEXO_DATA_URI_MAX) {
      throw new BadRequestException('Uma das imagens ficou grande demais. Tente recortar só a parte do problema.')
    }
    const m = DATA_URI.exec(v)
    if (!m) throw new BadRequestException('Envie imagens em PNG, JPG ou WebP.')
    const bytes = Buffer.from(m[2]!, 'base64')
    const tipo = tipoPelosBytes(bytes)
    if (!tipo || tipo !== `image/${m[1]}`) {
      throw new BadRequestException('Uma das imagens não é um PNG, JPG ou WebP válido.')
    }
    return { contentType: tipo, bytes }
  })
}

/** Extensão para o nome sugerido do arquivo. */
export function extensaoDe(tipo: string): string {
  return tipo === 'image/png' ? 'png' : tipo === 'image/webp' ? 'webp' : 'jpg'
}
