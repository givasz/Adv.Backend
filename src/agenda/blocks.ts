import { horariosOcupados } from '../profiles/agenda-publica'

/** Converte compromissos em horários da grade que se sobrepõem a eles. */
export function bloqueiosDaAgenda(
  entries: { startsAt: string; durationMin: number }[],
  daysJson: string,
  slotDurationMin: number,
): string[] {
  let days: { weekday: number; times: string[] }[] = []
  try {
    const parsed = JSON.parse(daysJson)
    if (Array.isArray(parsed)) days = parsed
  } catch { /* grade vazia */ }
  const blocks: string[] = []
  for (const entry of entries) {
    const date = entry.startsAt.slice(0, 10)
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay()
    const times = days.find((d) => d.weekday === weekday)?.times ?? []
    const begin = Number(entry.startsAt.slice(11, 13)) * 60 + Number(entry.startsAt.slice(14, 16))
    for (const time of times) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) continue
      const slot = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))
      if (slot < begin + entry.durationMin && begin < slot + slotDurationMin) blocks.push(`${date}T${time}`)
    }
  }
  return horariosOcupados(blocks)
}
