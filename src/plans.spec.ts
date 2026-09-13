import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME, LEGACY_THEME, THEME_TIER, resolveTheme } from './plans'

describe('resolveTheme — o servidor decide o tema que fica gravado', () => {
  it('tema do plano fica; tema acima do plano cai para o neutro', () => {
    expect(resolveTheme('linho', 'pro')).toBe('linho')
    expect(resolveTheme('linho', 'free')).toBe(DEFAULT_THEME)
    expect(resolveTheme('marinho', 'premium')).toBe('marinho')
    expect(resolveTheme('marinho', 'pro')).toBe(DEFAULT_THEME)
  })

  it('o Névoa é do Max desde 13/09/2026', () => {
    expect(THEME_TIER.nevoa).toBe('premium')
    expect(resolveTheme('nevoa', 'free')).toBe(DEFAULT_THEME)
    expect(resolveTheme('nevoa', 'premium')).toBe('nevoa')
  })

  it('só o neutro é do Free', () => {
    const livres = Object.entries(THEME_TIER).filter(([, tier]) => tier === 'free').map(([id]) => id)
    expect(livres).toEqual([DEFAULT_THEME])
  })

  it('id desconhecido, ausente ou de outro tipo cai para o neutro', () => {
    expect(resolveTheme('nao-existe', 'premium')).toBe(DEFAULT_THEME)
    expect(resolveTheme(undefined, 'premium')).toBe(DEFAULT_THEME)
    expect(resolveTheme(42, 'premium')).toBe(DEFAULT_THEME)
    // Chave herdada do protótipo não é tema nem apelido.
    expect(resolveTheme('constructor', 'premium')).toBe(DEFAULT_THEME)
    expect(resolveTheme('__proto__', 'premium')).toBe(DEFAULT_THEME)
  })

  it('id da coleção anterior vira o sucessor — e o sucessor é o que fica gravado', () => {
    for (const [antigo, novo] of Object.entries(LEGACY_THEME)) {
      expect(THEME_TIER[novo], `${antigo} → ${novo} precisa existir`).toBeDefined()
      expect(resolveTheme(antigo, 'premium')).toBe(novo)
    }
    // Quem tinha o Meia-noite (Max) e caiu para o Pro perde o sucessor também:
    // a escada vale para o id traduzido.
    expect(resolveTheme('meia-noite', 'pro')).toBe(DEFAULT_THEME)
  })
})
