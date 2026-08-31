// Saneamento de entrada — o corpo das requisições chega como `any` e é gravado
// no banco e depois lido por navegadores de visitantes. Estas funções são a
// fronteira: nada entra sem tipo conferido e teto de tamanho.
//
// Duas regras que valem para o arquivo inteiro:
//   1. Tipo errado NÃO derruba a requisição — vira o valor neutro (string vazia,
//      null, lista vazia). Um `bio: 12345` não pode virar 500.
//   2. Todo campo de texto tem teto. Campo sem limite é armazenamento de graça
//      para quem quiser abusar.

/** Endereços aceitos em qualquer link salvo pelo advogado. */
const ESQUEMAS_OK = new Set(['http:', 'https:'])

export const URL_MAX = 500
export const AVATAR_MAX = 400_000 // ~300 KB de imagem em data URI

/** Texto: qualquer coisa → string aparada e cortada no teto. */
export function clampText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

/** Como clampText, mas devolve null quando fica vazio (colunas opcionais). */
export function clampOrNull(value: unknown, max: number): string | null {
  const t = clampText(value, max)
  return t || null
}

/**
 * URL de link clicável. Só http/https: `javascript:` num href vira execução de
 * script na página pública do advogado, e `data:`/`file:` têm o mesmo problema
 * em navegadores antigos. Qualquer outra coisa vira null.
 */
export function safeUrl(value: unknown, max = URL_MAX): string | null {
  if (typeof value !== 'string') return null
  const bruto = value.trim()
  if (!bruto || bruto.length > max) return null
  // Sem esquema explícito, assume https — é o que a pessoa quis dizer ao colar
  // "instagram.com/fulano", e evita que o campo vire relativo à nossa origem.
  const candidato = /^[a-z][a-z0-9+.-]*:/i.test(bruto) ? bruto : `https://${bruto}`
  try {
    const u = new URL(candidato)
    if (!ESQUEMAS_OK.has(u.protocol)) return null
    if (!u.hostname || !u.hostname.includes('.')) return null
    return u.toString().slice(0, max)
  } catch {
    return null
  }
}

/**
 * Foto de perfil: ou um link https, ou a imagem embutida (data URI) que o próprio
 * navegador gerou ao recortar a foto. Formato e tamanho conferidos aqui porque o
 * corte acontece no cliente — e cliente não é barreira.
 */
export function safeImageSrc(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (!v) return null
  if (v.startsWith('data:')) {
    if (v.length > AVATAR_MAX) return null
    return /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v) ? v : null
  }
  const url = safeUrl(v)
  return url && url.startsWith('https://') ? url : null
}

/** Cor de destaque (white-label) — só hexadecimal. Texto livre aqui vira CSS injetado. */
export function safeHexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  return /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : null
}

/** Domínio próprio: só o nome do host, sem esquema, caminho, porta ou espaço. */
export function safeHostname(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (!v || v.length > 253) return null
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(v) ? v : null
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const EMAIL_MAX = 200

/** E-mail: formato conferido; qualquer outra coisa vira null. */
export function safeEmail(value: unknown): string | null {
  const v = clampText(value, EMAIL_MAX).toLowerCase()
  return v && EMAIL_RE.test(v) ? v : null
}

/** Telefone/WhatsApp: só dígitos e os separadores usuais. */
export function safePhone(value: unknown, max = 30): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim().slice(0, max)
  return v && /^[0-9+()\-.\s]{6,}$/.test(v) ? v : null
}

/** Lista: qualquer coisa → array cortado no teto de itens. */
export function clampList<T>(value: unknown, max: number): T[] {
  return Array.isArray(value) ? (value.slice(0, max) as T[]) : []
}

/** Um dos valores permitidos, ou o padrão. Allowlist, nunca blocklist. */
export function oneOf<T extends string>(value: unknown, permitidos: readonly T[], padrao: T): T {
  return typeof value === 'string' && (permitidos as readonly string[]).includes(value)
    ? (value as T)
    : padrao
}

// ---------------------------------------------------------------------------
// Endereço do escritório
//
// Fica aqui, e não em profiles/ ou firms/, porque os dois gravam as MESMAS seis
// colunas: um advogado tem endereço e a sociedade dele também. Duas cópias da
// mesma regra é a forma mais confiável de um dos lados aceitar um CEP com
// letras seis meses depois de o outro deixar de aceitar.
// ---------------------------------------------------------------------------

const CEP_DIGITOS = 8
const RUA_MAX = 120
const NUMERO_MAX = 20
const COMPLEMENTO_MAX = 60
const BAIRRO_MAX = 80

/** Colunas planas do endereço, como o Prisma as espera. */
export interface ColunasDeEndereco {
  addressZip: string | null
  addressStreet: string | null
  addressNumber: string | null
  addressComplement: string | null
  addressDistrict: string | null
  addressPublic: boolean
}

/**
 * O objeto `address` do corpo → as seis colunas.
 *
 * O CEP é gravado SÓ COM DÍGITOS. Formatação é decisão de quem exibe, e guardar
 * "01310-100" ao lado de "01310100" no mesmo banco faz qualquer busca por CEP
 * encontrar metade das linhas. Um CEP incompleto vira null em vez de entrar
 * pela metade — meio CEP não leva ninguém a lugar nenhum.
 *
 * `publico` ausente conta como `true`: quem preenche endereço no editor está
 * preenchendo para aparecer. Desligar é o ato deliberado, não o padrão.
 */
export function enderecoCols(value: unknown): ColunasDeEndereco {
  const e = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const cepDigitos = typeof e.cep === 'string' ? e.cep.replace(/\D/g, '') : ''
  return {
    addressZip: cepDigitos.length === CEP_DIGITOS ? cepDigitos : null,
    addressStreet: clampOrNull(e.rua, RUA_MAX),
    addressNumber: clampOrNull(e.numero, NUMERO_MAX),
    addressComplement: clampOrNull(e.complemento, COMPLEMENTO_MAX),
    addressDistrict: clampOrNull(e.bairro, BAIRRO_MAX),
    addressPublic: e.publico !== false,
  }
}

/** As colunas de volta ao objeto `address` do frontend. Sem nada, `undefined`. */
export function enderecoDaLinha(p: {
  addressZip?: string | null
  addressStreet?: string | null
  addressNumber?: string | null
  addressComplement?: string | null
  addressDistrict?: string | null
  addressPublic?: boolean | null
}): {
  cep?: string
  rua?: string
  numero?: string
  complemento?: string
  bairro?: string
  publico: boolean
} | undefined {
  const cheio =
    p.addressZip || p.addressStreet || p.addressNumber || p.addressComplement || p.addressDistrict
  if (!cheio) return undefined
  return {
    ...(p.addressZip ? { cep: p.addressZip } : {}),
    ...(p.addressStreet ? { rua: p.addressStreet } : {}),
    ...(p.addressNumber ? { numero: p.addressNumber } : {}),
    ...(p.addressComplement ? { complemento: p.addressComplement } : {}),
    ...(p.addressDistrict ? { bairro: p.addressDistrict } : {}),
    publico: p.addressPublic !== false,
  }
}
