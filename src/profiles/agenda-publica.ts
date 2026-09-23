// A grade do assistente virtual como o PÚBLICO a recebe — no perfil individual e
// na página do escritório, que oferece os horários de cada advogado.
//
// Fonte única: a leitura morava só dentro de profiles.service, e a página do
// escritório não tinha como oferecer a agenda dos membros sem copiar a regra (e
// uma cópia de poda de horário ocupado é exatamente o tipo de coisa que diverge).

import { canUseScheduling, canUseTriagem, type Plan } from '../plans'
import { normalizarTriagem, triagemAtiva, type TriagemConfig } from '../triagem'

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
  try {
    const agenda = JSON.parse(typeof p.calendarBusy === 'string' ? p.calendarBusy : '[]')
    busy = horariosOcupados([...busy, ...(Array.isArray(agenda) ? agenda : [])])
  } catch {
    /* Agenda inválida não altera os bloqueios manuais. */
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

/**
 * A triagem gravada nas colunas planas, como objeto.
 *
 * Fonte única das DUAS portas que a publicam: o perfil individual (buildTriage,
 * em profiles.service) e a página do escritório, onde o assistente da sociedade
 * faz as perguntas do advogado escolhido. Era privada do profiles.service, que é
 * exatamente por que o escritório ficou sem triagem nenhuma.
 *
 * Perk do Max: fora dele devolve `undefined`, e a trava vale na LEITURA também —
 * pela janela entre o vencimento da assinatura e a varredura que reconcilia o
 * banco (mesmo motivo do vídeo e do balão).
 */
export function triagemDoPerfil(p: any, plano: Plan): TriagemConfig | undefined {
  if (!canUseTriagem(plano)) return undefined
  let questions: unknown = []
  try {
    questions = JSON.parse(typeof p.triageQuestions === 'string' ? p.triageQuestions : '[]')
  } catch {
    /* JSON inválido → triagem vazia (a conversa volta a ser só a de agendamento) */
  }
  let semEtapas: unknown = []
  try {
    semEtapas = JSON.parse(typeof p.triageSkipSteps === 'string' ? p.triageSkipSteps : '[]')
  } catch {
    /* JSON inválido → nenhuma etapa tirada (a conversa faz todas) */
  }
  return normalizarTriagem({ enabled: p.triageEnabled === true, questions, semEtapas })
}

/**
 * A triagem de um MEMBRO do escritório, para o assistente da sociedade fazer as
 * perguntas dele.
 *
 * Só quando vale de verdade: plano, interruptor ligado e ao menos uma pergunta
 * respondível — as mesmas três condições do perfil individual. Fora disso,
 * `undefined`, e a conversa do escritório segue o roteiro curto de sempre.
 *
 * Nada aqui é novo para o público: são as mesmas perguntas que o perfil dele já
 * publica. O que muda é a porta por onde o visitante chegou.
 */
export function triagemPublica(p: any, plano: Plan): TriagemConfig | undefined {
  const config = triagemDoPerfil(p, plano)
  return config && triagemAtiva(config) ? config : undefined
}
