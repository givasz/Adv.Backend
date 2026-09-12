// A grade do assistente virtual como o PÚBLICO a recebe — no perfil individual e
// na página do escritório, que oferece os horários de cada advogado.
//
// Fonte única: a leitura morava só dentro de profiles.service, e a página do
// escritório não tinha como oferecer a agenda dos membros sem copiar a regra (e
// uma cópia de poda de horário ocupado é exatamente o tipo de coisa que diverge).

import { canUseScheduling, type Plan } from '../plans'

/** Um dia da grade do assistente como fica na coluna `assistantDays`. */
export interface AssistantDayCol {
  weekday: number
  times: string[]
  /** faixas de atendimento que geraram os horários ("das 07:00 às 11:00") */
  faixas?: { inicio: string; fim: string }[]
}

/**
 * Horários ocupados (o advogado marcando o que já foi combinado por fora).
 *
 * Só o formato "AAAA-MM-DDTHH:MM" entra, e só de hoje em diante — a poda no
 * caminho de gravação E no de leitura é o que mantém a lista pequena sem uma
 * tarefa agendada. A folga de um dia existe porque o servidor pensa em UTC e o
 * advogado, em Brasília: sem ela, a virada da meia-noite de lá liberaria um
 * horário que aqui ainda é hoje.
 *
 * Não há nada de terceiro aqui: nem nome, nem motivo, nem contato. A coluna
 * guarda quando, e mais nada.
 */
export function horariosOcupados(raw: unknown): string[] {
  const corte = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  const ok = (v: unknown): v is string =>
    typeof v === 'string' &&
    /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):([0-5]\d)$/.test(v) &&
    v.slice(0, 10) >= corte &&
    !Number.isNaN(Date.parse(`${v}:00Z`))
  const lista = Array.isArray(raw) ? raw.filter(ok) : []
  // Teto: 400 marcações cobrem meses de agenda cheia; acima disso é abuso ou bug.
  return [...new Set(lista)].sort().slice(0, 400)
}

/** A grade gravada: dias, ocupados e as regras da conversa. JSON quebrado vira grade vazia. */
export function gradeDoAssistente(p: any) {
  let days: AssistantDayCol[] = []
  try {
    const parsed = JSON.parse(typeof p.assistantDays === 'string' ? p.assistantDays : '[]')
    if (Array.isArray(parsed)) days = parsed
  } catch {
    /* JSON inválido → grade vazia (o front cai no padrão) */
  }
  let busy: string[] = []
  try {
    busy = horariosOcupados(JSON.parse(typeof p.assistantBusy === 'string' ? p.assistantBusy : '[]'))
  } catch {
    /* JSON inválido → nenhum horário ocupado (a grade volta inteira) */
  }
  return {
    days,
    busy,
    durationMin: p.assistantDurationMin ?? 45,
    leadHours: p.assistantLeadHours ?? 12,
    horizonDays: p.assistantHorizonDays ?? 14,
  }
}

/**
 * A agenda de um MEMBRO do escritório, para o assistente da sociedade oferecer os
 * horários dele.
 *
 * Só existe quando o próprio advogado ligou o assistente e o plano vigente permite
 * agendamento — a mesma condição que faz o perfil dele oferecer horário. Fora
 * disso, `undefined`, e a conversa do escritório pergunta dia e período.
 *
 * Nada aqui é novo para o público: dias, horários e ocupados já saem no JSON do
 * perfil individual. A frase de abertura e o balão ficam de fora — são do perfil,
 * não da sociedade.
 */
export function agendaPublica(p: any, plano: Plan) {
  if (!canUseScheduling(plano) || p.schedulingMode !== 'assistant') return undefined
  const grade = gradeDoAssistente(p)
  return grade.days.length ? grade : undefined
}
