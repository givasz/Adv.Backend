// Vídeo de apresentação (plano Max) — validação do link no servidor.
//
// FONTE DA VERDADE do que é aceito. O front espelha em frontend/src/lib/video.ts,
// mas quem grava é aqui: só YouTube e Vimeo entram no banco. Sem isto, um cliente
// forjado poderia salvar qualquer URL e o perfil público montaria um <iframe>
// apontando para ela.

const YOUTUBE_PATTERNS = [
  /(?:youtube\.com|youtube-nocookie\.com)\/watch\?(?:.*&)?v=([\w-]{6,20})/i,
  /youtu\.be\/([\w-]{6,20})/i,
  /(?:youtube\.com|youtube-nocookie\.com)\/(?:embed|shorts|live|v)\/([\w-]{6,20})/i,
]
const VIMEO_PATTERNS = [/vimeo\.com\/(?:video\/)?(\d{6,12})/i]

/** Legenda curta sob o vídeo (espelha VIDEO_CAPTION_MAX no front). */
export const VIDEO_CAPTION_MAX = 120

/**
 * Devolve a URL canônica do vídeo se o link for de um provedor aceito; null caso
 * contrário. Normaliza para a forma canônica do provedor — assim o que fica no
 * banco não carrega parâmetros de rastreio nem lixo colado da barra de endereços.
 */
export function normalizeVideoUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const url = raw.trim()
  if (!url) return null

  for (const re of YOUTUBE_PATTERNS) {
    const id = re.exec(url)?.[1]
    if (id) return `https://www.youtube.com/watch?v=${id}`
  }
  for (const re of VIMEO_PATTERNS) {
    const id = re.exec(url)?.[1]
    if (id) return `https://vimeo.com/${id}`
  }
  return null
}

/** Vídeo de apresentação no perfil — exclusivo do Max. */
export function canUseVideo(plan: string | undefined): boolean {
  return plan === 'premium'
}
