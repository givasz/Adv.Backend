// DIA E MÊS EM SÃO PAULO — a única coisa que decide o rótulo de um retrato.
//
// O servidor roda em UTC, o Prisma guarda `timestamp` sem fuso e o advogado vive
// em Brasília. Três relógios para a mesma pergunta ("que dia é hoje?"), e a
// resposta errada não dá erro nenhum: só empurra três horas de movimento — das
// 21h à meia-noite, justamente quando alguém procura advogado depois do
// expediente — para o dia seguinte, todo dia, para sempre.
//
// ---------------------------------------------------------------------------
// A CONVENÇÃO
//
// `dia` e `mes` nas tabelas de BI são RÓTULOS de calendário, não instantes:
// guardamos a meia-noite UTC do dia de São Paulo. Guardar o instante real
// (03:00Z) faria todo `::date` no SQL depender do fuso da sessão que consulta —
// e o Power BI abre a sessão com o fuso que quiser.
//
// Quem precisa do INSTANTE (para filtrar LinkEvent, por exemplo) usa
// `instanteDoLocal`, e não o rótulo.
// ---------------------------------------------------------------------------

export const FUSO = 'America/Sao_Paulo'

const RELOGIO = new Intl.DateTimeFormat('en-US', {
  timeZone: FUSO,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

interface Parede {
  ano: number
  mes: number
  dia: number
  hora: number
  minuto: number
  segundo: number
}

/** O que o relógio de parede em São Paulo mostra neste instante. */
function parede(instante: Date): Parede {
  const p = Object.fromEntries(
    RELOGIO.formatToParts(instante).map((x) => [x.type, x.value]),
  ) as Record<string, string>
  return {
    ano: Number(p.year),
    mes: Number(p.month),
    dia: Number(p.day),
    hora: Number(p.hour),
    minuto: Number(p.minute),
    segundo: Number(p.second),
  }
}

/**
 * Quanto o fuso está deslocado NESTE instante, em milissegundos (−3h no Brasil
 * de hoje). Medido, não constante: horário de verão vai e volta por decreto, e
 * uma constante `-3` envelheceria em silêncio no dia em que voltasse.
 */
function deslocamento(instante: Date): number {
  const p = parede(instante)
  return Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo) - instante.getTime()
}

/** Rótulo do dia de calendário em São Paulo (meia-noite UTC). */
export function diaLocal(instante: Date = new Date()): Date {
  const p = parede(instante)
  return new Date(Date.UTC(p.ano, p.mes - 1, p.dia))
}

/** Rótulo do primeiro dia do mês em São Paulo (meia-noite UTC). */
export function mesLocal(instante: Date = new Date()): Date {
  const p = parede(instante)
  return new Date(Date.UTC(p.ano, p.mes - 1, 1))
}

/**
 * O INSTANTE real correspondente a uma hora de parede em São Paulo.
 *
 * Duas passadas de propósito. O deslocamento depende do instante, e o instante é
 * o que se está procurando — então a primeira passada usa o deslocamento do
 * palpite e a segunda o corrige. Sem ela, o único dia do ano em que o relógio
 * muda ficaria uma hora torto; com ela, o erro se fecha.
 */
export function instanteDoLocal(ano: number, mes: number, dia: number): Date {
  const alvo = Date.UTC(ano, mes - 1, dia)
  const palpite = alvo - deslocamento(new Date(alvo))
  return new Date(alvo - deslocamento(new Date(palpite)))
}

/** O mês seguinte ao rótulo dado. */
export function mesSeguinte(rotulo: Date): Date {
  return new Date(Date.UTC(rotulo.getUTCFullYear(), rotulo.getUTCMonth() + 1, 1))
}

/** O mês anterior ao rótulo dado. */
export function mesAnterior(rotulo: Date): Date {
  return new Date(Date.UTC(rotulo.getUTCFullYear(), rotulo.getUTCMonth() - 1, 1))
}

/**
 * A janela de instantes que um rótulo de mês cobre: [início, fim). É o que vai
 * para o `where` do LinkEvent — filtrar por rótulo pegaria três horas do mês
 * vizinho em cada ponta.
 */
export function janelaDoMes(rotulo: Date): { inicio: Date; fim: Date } {
  const seguinte = mesSeguinte(rotulo)
  return {
    inicio: instanteDoLocal(rotulo.getUTCFullYear(), rotulo.getUTCMonth() + 1, 1),
    fim: instanteDoLocal(seguinte.getUTCFullYear(), seguinte.getUTCMonth() + 1, 1),
  }
}
