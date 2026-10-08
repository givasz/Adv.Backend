// Regras de senha do CADASTRO — fonte da verdade no servidor.
//
// Espelha frontend/src/lib/passwordStrength.ts. O front avalia enquanto a pessoa
// digita (barra de força, dicas); aqui é onde a regra realmente vale, porque
// validação de cliente é sugestão, não barreira.
//
// O critério segue a orientação moderna (NIST SP 800-63B): protege a conta o
// COMPRIMENTO e não ser adivinhável — não obrigar maiúscula, número e símbolo.
// Regras de composição empurram todo mundo para "Senha@123", que é exatamente o
// que os ataques de dicionário testam primeiro.
//
// Afrouxada em 08/10/2026 junto com o front: sequência/repetição só reprova
// quando sobra pouca senha fora dela ("maria1234" passa), "OAB" saiu da lista
// ("joaobarros" tinha um "oab" escondido) e 10+ letras dispensam mistura.
//
// O LOGIN não passa por aqui: endurecer a regra não pode trancar quem já tem
// conta com uma senha criada sob a regra antiga.

export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 128
const SEM_MISTURA = 10
const SOBRA_MINIMA = 4

const COMUNS = new Set([
  '12345678', '123456789', '1234567890', '123456', 'senha123', 'senha1234',
  'password', 'password1', 'password123', 'qwerty123', 'qwertyui', 'abc12345',
  'advogado', 'advogada', 'advocacia', 'direito1', 'oab12345', 'brasil123',
  'flamengo', 'corinthians', 'saopaulo', 'palmeiras', 'gremio12', 'vasco123',
  'teste123', 'admin123', 'mudar123', 'iloveyou', 'princesa', 'familia1',
  'jesus123', 'deusefiel', 'amordeus', '11223344', '00000000', 'aaaaaaaa',
  'asdfghjk', 'zxcvbnm1', '1q2w3e4r', 'a1b2c3d4', 'naosei123', 'minhasenha',
])

const LINHAS_TECLADO = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890']

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

function trechoPrevisivel(s: string): { sobra: number; repeticao: boolean } {
  const t = normalize(s)
  const seq = new Array<boolean>(t.length).fill(false)
  const rep = new Array<boolean>(t.length).fill(false)
  const marca = (m: boolean[], ini: number, fim: number) => {
    if (fim - ini >= 4) for (let k = ini; k < fim; k++) m[k] = true
  }
  // corridas: subindo (abcd), descendo (4321) e o mesmo caractere (aaaa)
  for (const passo of [1, -1, 0]) {
    let ini = 0
    for (let i = 1; i <= t.length; i++) {
      if (i < t.length && t.charCodeAt(i) - t.charCodeAt(i - 1) === passo) continue
      marca(passo === 0 ? rep : seq, ini, i)
      ini = i
    }
  }
  // trechos de linha de teclado (qwer, lkjh) — não são sequência de código
  for (const linha of LINHAS_TECLADO) {
    for (const l of [linha, [...linha].reverse().join('')]) {
      for (let i = 0; i + 4 <= t.length; i++) if (l.includes(t.slice(i, i + 4))) marca(seq, i, i + 4)
    }
  }
  const nSeq = seq.filter(Boolean).length
  const nRep = rep.filter(Boolean).length
  const coberto = seq.filter((x, i) => x || rep[i]).length
  return { sobra: coberto ? t.length - coberto : Infinity, repeticao: nRep > nSeq }
}

function classes(s: string): number {
  return (
    Number(/[a-z]/.test(s)) +
    Number(/[A-Z]/.test(s)) +
    Number(/\d/.test(s)) +
    Number(/[^a-zA-Z\d]/.test(s))
  )
}

/** Primeira coisa a corrigir na senha, ou null se ela serve. */
export function passwordProblem(password: string, email = ''): string | null {
  const senha = password ?? ''
  if (!senha) return 'Escolha uma senha.'
  const t = normalize(senha)

  if (senha.length < PASSWORD_MIN) return `Use ao menos ${PASSWORD_MIN} caracteres.`
  if (senha.length > PASSWORD_MAX) return `No máximo ${PASSWORD_MAX} caracteres.`
  if (COMUNS.has(t)) return 'Essa senha é das mais usadas no mundo — troque por outra.'
  const previsivel = trechoPrevisivel(senha)
  if (previsivel.sobra < SOBRA_MINIMA) {
    return previsivel.repeticao
      ? 'Evite repetir o mesmo caractere várias vezes.'
      : 'Evite sequências como 1234, abcd ou qwerty.'
  }

  const local = normalize((email || '').split('@')[0] ?? '')
  if (local.length >= 4 && t.includes(local)) return 'Não use o seu e-mail dentro da senha.'
  if (t.includes('advoc')) return 'Não use o nome do site na senha.'
  if (senha.length < SEM_MISTURA && classes(senha) < 2) return 'Misture letras com números ou símbolos.'

  return null
}
