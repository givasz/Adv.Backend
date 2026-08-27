// Segundo fator do painel — TOTP (RFC 6238), o código de 6 dígitos que troca a
// cada 30 segundos. É o que o Google Authenticator, o Authy e o gerenciador de
// senhas do celular já sabem ler.
//
// Sem dependência nova, no mesmo espírito de user-auth.ts: HMAC-SHA1 e base32
// cabem em `node:crypto` mais trinta linhas. Um pacote a mais aqui seria mais
// uma coisa a auditar na porta mais valiosa da plataforma.
//
// Por que TOTP e não SMS ou e-mail: SMS é interceptável e depende de operadora;
// e-mail seria o segundo fator morando na mesma caixa que recupera a senha — ou
// seja, um fator só, com duas etapas. O TOTP fica no aparelho.
//
// Escolhas fixas, iguais às do resto do mundo (o app do usuário não pergunta):
// SHA-1, 6 dígitos, janela de 30 segundos.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const DIGITOS = 6
const PASSO_S = 30
const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567' // base32, RFC 4648

// ---- base32 -----------------------------------------------------------------

function base32Encode(buf: Buffer): string {
  let bits = 0
  let valor = 0
  let saida = ''
  for (const byte of buf) {
    valor = (valor << 8) | byte
    bits += 8
    while (bits >= 5) {
      saida += ALFABETO[(valor >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) saida += ALFABETO[(valor << (5 - bits)) & 31]
  return saida
}

function base32Decode(texto: string): Buffer {
  // Tolerante com o que a pessoa digita: espaços, minúsculas e o "=" de
  // preenchimento entram e saem sem drama.
  const limpo = (texto || '').toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0
  let valor = 0
  const bytes: number[] = []
  for (const ch of limpo) {
    const i = ALFABETO.indexOf(ch)
    if (i < 0) throw new Error('segredo inválido')
    valor = (valor << 5) | i
    bits += 5
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

// ---- Segredo ----------------------------------------------------------------

/**
 * Sorteia um segredo novo (20 bytes = 160 bits, o tamanho recomendado pela
 * RFC 4226). Sai em base32 porque é o formato que os aplicativos leem.
 */
export function novoSegredoTotp(): string {
  return base32Encode(randomBytes(20))
}

/** O segredo em blocos de quatro, para quem vai digitar à mão no aplicativo. */
export function segredoLegivel(segredo: string): string {
  return (segredo.match(/.{1,4}/g) ?? []).join(' ')
}

// ---- Código -----------------------------------------------------------------

/** Código de um contador específico (contador = segundos / 30). */
export function codigoTotp(segredo: string, contador: number): string {
  const chave = base32Decode(segredo)
  const buf = Buffer.alloc(8)
  // O contador é de 64 bits. `writeBigUInt64BE` evita o erro clássico de
  // escrever só os 32 bits baixos — que funciona por décadas e depois não.
  buf.writeBigUInt64BE(BigInt(Math.floor(contador)))

  const hmac = createHmac('sha1', chave).update(buf).digest()
  // Truncagem dinâmica da RFC 4226: o último nibble diz onde começar a ler.
  const offset = hmac[hmac.length - 1]! & 0x0f
  const binario =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff)

  return String(binario % 10 ** DIGITOS).padStart(DIGITOS, '0')
}

function iguais(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

/**
 * O código apresentado vale agora?
 *
 * `janela` é quantos passos de 30s aceitar para trás e para frente. Um é o
 * padrão da indústria: cobre o relógio do celular fora de hora e a digitação que
 * atravessa a virada do código, sem esticar a validade a ponto de importar.
 *
 * A comparação é resistente a timing — um código de 6 dígitos tem só um milhão
 * de possibilidades, e vazar por tempo qual dígito bateu reduz isso a nada.
 * Falha FECHADA: segredo estragado ou código malformado devolvem false.
 */
export function totpConfere(
  segredo: string | null | undefined,
  codigo: string | undefined,
  janela = 1,
  agoraMs = Date.now(),
): boolean {
  const limpo = (codigo ?? '').replace(/\D/g, '')
  if (!segredo || limpo.length !== DIGITOS) return false
  try {
    const contador = Math.floor(agoraMs / 1000 / PASSO_S)
    for (let d = -janela; d <= janela; d++) {
      if (iguais(limpo, codigoTotp(segredo, contador + d))) return true
    }
    return false
  } catch {
    return false
  }
}

// ---- Cadastro no aplicativo -------------------------------------------------

/**
 * Endereço `otpauth://` que o aplicativo lê do QR.
 *
 * O rótulo leva emissor e conta ("advoc.me:ana@escritorio.com") porque é assim
 * que a lista do aplicativo fica legível para quem administra mais de um sistema.
 */
export function otpauthUrl(segredo: string, conta: string, emissor = 'advoc.me painel'): string {
  const rotulo = encodeURIComponent(`${emissor}:${conta}`)
  const params = new URLSearchParams({
    secret: segredo,
    issuer: emissor,
    algorithm: 'SHA1',
    digits: String(DIGITOS),
    period: String(PASSO_S),
  })
  return `otpauth://totp/${rotulo}?${params.toString()}`
}
