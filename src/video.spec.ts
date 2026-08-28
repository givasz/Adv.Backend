import { describe, expect, it } from 'vitest'
import { normalizeVideoUrl, VIDEO_ORIENTATIONS } from './video'

describe('canonicalização do link de vídeo', () => {
  it('reduz as formas do YouTube a uma só', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
      'https://youtube.com/watch?v=aqz-KE-bpKQ&t=42s',
      'https://youtu.be/aqz-KE-bpKQ?si=rastreio',
      'https://www.youtube.com/embed/aqz-KE-bpKQ',
    ]) {
      expect(normalizeVideoUrl(url)).toBe('https://www.youtube.com/watch?v=aqz-KE-bpKQ')
    }
  })

  // O bug silencioso que este teste existe para não deixar voltar: a
  // canonicalização mandava TODO link do YouTube para `watch?v=`, Shorts
  // inclusive. O vídeo tocava igual, então nada parecia errado — mas a
  // informação de que ele era VERTICAL era descartada no save, sem como
  // recuperá-la. O perfil desenhava um quadro 16:9 com o vídeo em pé no meio,
  // entre duas tarjas pretas.
  it('Short continua Short — é a única pista de orientação que temos de graça', () => {
    expect(normalizeVideoUrl('https://www.youtube.com/shorts/aqz-KE-bpKQ')).toBe(
      'https://www.youtube.com/shorts/aqz-KE-bpKQ',
    )
    expect(normalizeVideoUrl('https://youtube.com/shorts/aqz-KE-bpKQ?feature=share')).toBe(
      'https://www.youtube.com/shorts/aqz-KE-bpKQ',
    )
  })

  it('Vimeo idem', () => {
    expect(normalizeVideoUrl('https://vimeo.com/video/123456789')).toBe('https://vimeo.com/123456789')
  })

  it('recusa o que não é YouTube nem Vimeo', () => {
    for (const ruim of ['https://evil.com/v/1', 'javascript:alert(1)', '', 42, null]) {
      expect(normalizeVideoUrl(ruim)).toBeNull()
    }
  })
})

describe('orientações aceitas', () => {
  it('são exatamente três, e "auto" é uma delas', () => {
    expect([...VIDEO_ORIENTATIONS]).toEqual(['auto', 'horizontal', 'vertical'])
  })
})
