// CPF e CNPJ de quem paga.
//
// O Asaas não cria cliente sem documento, e o documento só serve para isso: ele
// vai ao provedor na hora da assinatura e NÃO é gravado aqui. Guardar CPF que não
// usamos seria dado pessoal parado esperando vazar (LGPD, art. 6º, III — necessidade).
//
// A conferência dos dígitos acontece antes da ida ao provedor por dois motivos: a
// mensagem chega ao advogado na hora, no campo certo, em vez de um erro genérico
// do Asaas; e um documento obviamente inválido não gasta uma chamada nem conta
// como tentativa de pagamento.
//
// Só confere que o número É um CPF ou CNPJ possível. Não confere que pertence a
// quem digitou — isso nem o Asaas faz, e não é papel nosso.

/** Só os dígitos. */
export function digitos(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\D/g, '') : ''
}

function todosIguais(d: string): boolean {
  return /^(\d)\1+$/.test(d)
}

/** Dígito verificador no esquema do CPF e do CNPJ: soma ponderada, resto de 11. */
function dv(base: string, pesos: number[]): number {
  const soma = base.split('').reduce((t, c, i) => t + Number(c) * pesos[i], 0)
  const resto = soma % 11
  return resto < 2 ? 0 : 11 - resto
}

export function cpfValido(v: unknown): boolean {
  const d = digitos(v)
  if (d.length !== 11 || todosIguais(d)) return false
  const p1 = [10, 9, 8, 7, 6, 5, 4, 3, 2]
  const p2 = [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]
  return dv(d.slice(0, 9), p1) === Number(d[9]) && dv(d.slice(0, 10), p2) === Number(d[10])
}

export function cnpjValido(v: unknown): boolean {
  const d = digitos(v)
  if (d.length !== 14 || todosIguais(d)) return false
  const p1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  const p2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  return dv(d.slice(0, 12), p1) === Number(d[12]) && dv(d.slice(0, 13), p2) === Number(d[13])
}

/**
 * CPF ou CNPJ válido → só os dígitos. Inválido → `null`.
 *
 * Os dois servem: o advogado pode assinar como pessoa física ou pela sociedade.
 */
export function documentoValido(v: unknown): string | null {
  const d = digitos(v)
  if (d.length === 11) return cpfValido(d) ? d : null
  if (d.length === 14) return cnpjValido(d) ? d : null
  return null
}
