// A escada de sanções.
//
// Estes testes guardam decisões que custam processo dos dois lados: um degrau
// que deixe de suspender a cobrança gera cobrança por serviço indisponível; uma
// medida sem prazo vira punição perpétua; e uma acusação de identidade aceita
// anonimamente tira o nome de alguém do ar por reclamação de quem não tem rosto.
//
// Fundamento de cada regra em docs/politica-de-sancoes.md.

import { describe, expect, it } from 'vitest'
import {
  ESCADA,
  MOTIVOS_QUE_EXIGEM_IDENTIFICACAO,
  REGIMES,
  REGIME_DO_MOTIVO,
  degrau,
  exigeIdentificacao,
  isRegime,
  medidaVigente,
  venceEm,
} from './sancoes'
import { REPORT_REASONS } from '../moderation/moderation.constants'

const DIA = 24 * 60 * 60 * 1000

describe('a escada', () => {
  it('é uma escada de verdade: graus em ordem, sem repetir', () => {
    const graus = ESCADA.map((d) => d.grau)
    expect(graus).toEqual([...graus].sort((a, b) => a - b))
    expect(new Set(graus).size).toBe(graus.length)
  })

  it('do degrau que tira o serviço do ar em diante, a cobrança para', () => {
    // Serviço pago e indisponível não segue sendo cobrado (CDC art. 51, IV) — e
    // isso é indefensável mesmo quando a restrição é justa.
    for (const d of ESCADA) {
      if (d.grau >= 3) expect(d.suspendeCobranca, d.id).toBe(true)
      else expect(d.suspendeCobranca, d.id).toBe(false)
    }
  })

  it('todo degrau dá prazo de contestação', () => {
    for (const d of ESCADA) expect(d.contestacaoDias, d.id).toBeGreaterThan(0)
  })

  it('só o encerramento é definitivo, e só ele exige duas mãos', () => {
    const definitivos = ESCADA.filter((d) => d.prazoPadraoDias === 0)
    expect(definitivos.map((d) => d.id)).toEqual(['close'])
    expect(ESCADA.filter((d) => d.duasMaos).map((d) => d.id)).toEqual(['close'])
  })

  it('o que alcança a conta vem depois do que alcança o perfil', () => {
    const primeiroDeConta = ESCADA.find((d) => d.alvo === 'conta')!.grau
    const ultimoDePerfil = Math.max(...ESCADA.filter((d) => d.alvo === 'perfil').map((d) => d.grau))
    expect(primeiroDeConta).toBeGreaterThan(ultimoDePerfil)
  })

  it('degrau inexistente devolve undefined em vez de estourar', () => {
    expect(degrau('banir-para-sempre')).toBeUndefined()
  })
})

describe('prazo', () => {
  const agora = 1_700_000_000_000

  it('sem pedido, usa o padrão do degrau', () => {
    expect(venceEm('warn', undefined, agora)!.getTime()).toBe(agora + 30 * DIA)
  })

  it('respeita o prazo pedido', () => {
    expect(venceEm('restrict', 7, agora)!.getTime()).toBe(agora + 7 * DIA)
  })

  it('tem teto — um ano é sanção, mais que isso é esquecimento', () => {
    expect(venceEm('restrict', 99999, agora)!.getTime()).toBe(agora + 365 * DIA)
  })

  it('zero significa "não vence"', () => {
    expect(venceEm('restrict', 0, agora)).toBeNull()
    expect(venceEm('close', undefined, agora)).toBeNull()
  })

  it('lixo cai no padrão — e NUNCA em medida perpétua', () => {
    // Number(null), Number('') e Number([]) valem 0, e zero significa "não
    // vence". Antes da correção, qualquer um desses campos malformados produzia
    // uma restrição para sempre — o contrário exato do que o prazo garante.
    for (const v of ['abc', -3, null, undefined, {}, [], '', NaN, true]) {
      const d = venceEm('warn', v, agora)
      expect(d, String(v)).not.toBeNull()
      expect(d!.getTime(), String(v)).toBe(agora + 30 * DIA)
    }
  })

  it('só um zero ESCRITO significa "sem prazo"', () => {
    expect(venceEm('restrict', 0, agora)).toBeNull()
    expect(venceEm('restrict', '0', agora)).toBeNull()
  })
})

describe('a medida ainda vale?', () => {
  const agora = 1_700_000_000_000

  it('perfil ativo nunca está sob medida', () => {
    expect(medidaVigente('active', new Date(agora + DIA), agora)).toBe(false)
    expect(medidaVigente(null, null, agora)).toBe(false)
  })

  it('dentro do prazo, vale', () => {
    expect(medidaVigente('restricted', new Date(agora + DIA), agora)).toBe(true)
  })

  it('vencida, não vale mais — e ninguém precisou rodar nada para isso', () => {
    expect(medidaVigente('restricted', new Date(agora - 1), agora)).toBe(false)
  })

  it('medida antiga, sem prazo, continua valendo', () => {
    // As que existiam antes desta fase. Não somem sozinhas; alguém decide.
    expect(medidaVigente('restricted', null, agora)).toBe(true)
  })
})

describe('regimes', () => {
  it('todo motivo de denúncia tem regime', () => {
    for (const motivo of REPORT_REASONS) {
      expect(REGIME_DO_MOTIVO[motivo], motivo).toBeDefined()
      expect(isRegime(REGIME_DO_MOTIVO[motivo])).toBe(true)
    }
  })

  it('só o regime do ilícito grave age antes do contraditório', () => {
    expect(REGIMES.A.agirAntesDoContraditorio).toBe(true)
    expect(REGIMES.B.agirAntesDoContraditorio).toBe(false)
    expect(REGIMES.C.agirAntesDoContraditorio).toBe(false)
  })

  it('regime desconhecido é recusado', () => {
    expect(isRegime('D')).toBe(false)
    expect(isRegime(undefined)).toBe(false)
  })
})

describe('identificação do denunciante', () => {
  it('acusação sobre a IDENTIDADE de alguém não é anônima', () => {
    expect(exigeIdentificacao('oab_invalid')).toBe(true)
    expect(exigeIdentificacao('impersonation')).toBe(true)
  })

  it('os demais motivos seguem anônimos, de propósito', () => {
    // Quem denuncia captação irregular de um colega não deve precisar se expor
    // numa profissão pequena e competitiva.
    for (const motivo of REPORT_REASONS) {
      if ((MOTIVOS_QUE_EXIGEM_IDENTIFICACAO as readonly string[]).includes(motivo)) continue
      expect(exigeIdentificacao(motivo), motivo).toBe(false)
    }
  })

  it('todo motivo que exige identificação existe de verdade', () => {
    for (const m of MOTIVOS_QUE_EXIGEM_IDENTIFICACAO) {
      expect(REPORT_REASONS as readonly string[]).toContain(m)
    }
  })
})
